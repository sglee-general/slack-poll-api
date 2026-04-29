import crypto from 'crypto';
import fetch from 'node-fetch';
import { kv } from '@vercel/kv';
import qs from 'querystring';

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;

// -----------------------------
// 1. Slack 서명 검증
// -----------------------------
function verifySlackRequest(req, rawBody) {
  const timestamp = req.headers['x-slack-request-timestamp'];
  const signature = req.headers['x-slack-signature'];

  const baseString = `v0:${timestamp}:${rawBody}`;
  const hmac = crypto.createHmac('sha256', SIGNING_SECRET);
  const hash = 'v0=' + hmac.update(baseString).digest('hex');

  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(signature));
}

// -----------------------------
// 2. Slack API 호출 함수
// -----------------------------
async function slackAPI(method, body) {
  return fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

// -----------------------------
// 3. 메인 핸들러
// -----------------------------
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('OK');
  }

  // raw body 읽기
  const buffers = [];
  for await (const chunk of req) buffers.push(chunk);
  const rawBody = Buffer.concat(buffers).toString();

  // 서명 검증
  if (!verifySlackRequest(req, rawBody)) {
    return res.status(401).send('Invalid signature');
  }

  // body 파싱
  let payload;
  const parsed = qs.parse(rawBody);

  if (parsed.payload) {
    payload = JSON.parse(parsed.payload);
  } else {
    payload = parsed;
  }

  // -----------------------------
  // 4. Slash Command
  // -----------------------------
  if (payload.command === '/설문') {
    res.status(200).end(); // 🔥 즉시 ack

    await slackAPI('views.open', {
      trigger_id: payload.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'poll_modal',
        private_metadata: payload.channel_id,
        title: { type: 'plain_text', text: '📊 설문 생성' },
        submit: { type: 'plain_text', text: '시작' },
        blocks: [
          {
            type: 'input',
            block_id: 'topic',
            element: {
              type: 'plain_text_input',
              action_id: 'topic_input',
            },
            label: { type: 'plain_text', text: '설문 주제' },
          },
        ],
      },
    });

    return;
  }

  // -----------------------------
  // 5. 모달 제출
  // -----------------------------
  if (payload.type === 'view_submission') {
    res.status(200).end(); // 🔥 즉시 ack

    const topic = payload.view.state.values.topic.topic_input.value;
    const channel = payload.view.private_metadata;

    const result = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        channel,
        text: `📊 설문: ${topic}`,
      }),
    }).then(r => r.json());

    await kv.hset(`poll:${result.ts}`, {});
    return;
  }

  // -----------------------------
  // 6. 버튼 클릭
  // -----------------------------
  if (payload.type === 'block_actions') {
    res.status(200).end(); // 🔥 즉시 ack

    const action = payload.actions[0];

    // 투표
    if (action.action_id.startsWith('vote_')) {
      await kv.hset(`poll:${payload.message.ts}`, {
        [payload.user.id]: action.value,
      });
    }

    // 종료
    if (action.action_id === 'end_poll') {
      const votes = await kv.hgetall(`poll:${payload.message.ts}`);
      const tally = {};

      Object.values(votes || {}).forEach(v => {
        tally[v] = (tally[v] || 0) + 1;
      });

      let text = '📊 설문 결과\n\n';
      for (const [k, v] of Object.entries(tally)) {
        text += `• ${k}: ${v}표\n`;
      }

      await slackAPI('chat.update', {
        channel: payload.channel.id,
        ts: payload.message.ts,
        text,
      });
    }

    return;
  }

  res.status(200).end();
}

export const config = {
  api: {
    bodyParser: false,
  },
};
