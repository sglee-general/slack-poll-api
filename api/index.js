import crypto from 'crypto';
import { kv } from '@vercel/kv';
import qs from 'querystring';

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;

// -----------------------------
// 1. 서명 검증
// -----------------------------
function verifySlackRequest(req, rawBody) {
  const timestamp = req.headers['x-slack-request-timestamp'];
  const signature = req.headers['x-slack-signature'];

  const baseString = `v0:${timestamp}:${rawBody}`;
  const hash =
    'v0=' +
    crypto.createHmac('sha256', SIGNING_SECRET).update(baseString).digest('hex');

  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(signature));
}

// -----------------------------
// 2. Slack API 호출
// -----------------------------
async function slackAPI(method, body) {
  return fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }).then((res) => res.json());
}

// -----------------------------
// 3. 핸들러
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
  // Slash Command
  // -----------------------------
  if (payload.command === '/설문') {
    res.status(200).end(); // ack

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
  // 모달 제출
  // -----------------------------
  if (payload.type === 'view_submission') {
    res.status(200).end();

    const topic = payload.view.state.values.topic.topic_input.value;
    const channel = payload.view.private_metadata;

    const result = await slackAPI('chat.postMessage', {
      channel,
      text: `📊 설문: ${topic}`,
    });

    await kv.hset(`poll:${result.ts}`, {});
    return;
  }

  // -----------------------------
  // 버튼 클릭
  // -----------------------------
  if (payload.type === 'block_actions') {
    res.status(200).end();

    const action = payload.actions[0];

    if (action.action_id.startsWith('vote_')) {
      await kv.hset(`poll:${payload.message.ts}`, {
        [payload.user.id]: action.value,
      });
    }

    if (action.action_id === 'end_poll') {
      const votes = await kv.hgetall(`poll:${payload.message.ts}`);
      const tally = {};

      Object.values(votes || {}).forEach((v) => {
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

// -----------------------------
export const config = {
  api: {
    bodyParser: false,
  },
};
