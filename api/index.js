const crypto = require('crypto');
const { kv } = require('@vercel/kv');
const qs = require('querystring');

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;

// -----------------------------
// 1. 서명 검증
// -----------------------------
function verifySlackRequest(req, rawBody) {
  const timestamp = req.headers['x-slack-request-timestamp'];
  const signature = req.headers['x-slack-signature'];

  if (!timestamp || !signature) return false;

  const baseString = `v0:${timestamp}:${rawBody}`;
  const hash =
    'v0=' +
    crypto.createHmac('sha256', SIGNING_SECRET).update(baseString).digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(signature));
  } catch {
    return false;
  }
}

// -----------------------------
// 2. Slack API 호출
// -----------------------------
async function slackAPI(method, body) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  return res.json();
}

// -----------------------------
// 3. 핸들러
// -----------------------------
module.exports = async (req, res) => {
  try {
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
    const parsed = qs.parse(rawBody);
    let payload;

    if (parsed.payload) {
      payload = JSON.parse(parsed.payload);
    } else {
      payload = parsed;
    }

    // -----------------------------
    // 1. Slash Command
    // -----------------------------
    if (payload.command === '/설문') {
      res.status(200).end(); // ack

      setTimeout(async () => {
        try {
          const optionBlocks = [1, 2, 3, 4, 5].map((n) => ({
            type: 'input',
            block_id: `opt_${n}`,
            optional: n > 2,
            element: {
              type: 'plain_text_input',
              action_id: `input_${n}`,
            },
            label: { type: 'plain_text', text: `선택지 ${n}` },
          }));

          await slackAPI('views.open', {
            trigger_id: payload.trigger_id,
            view: {
              type: 'modal',
              callback_id: 'poll_modal',
              private_metadata: payload.channel_id,
              title: { type: 'plain_text', text: '📊 설문 생성' },
              submit: { type: 'plain_text', text: '설문 시작' },
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
                { type: 'divider' },
                ...optionBlocks,
              ],
            },
          });
        } catch (e) {
          console.error('views.open 에러:', e);
        }
      }, 0);

      return;
    }

    // -----------------------------
    // 2. 모달 제출
    // -----------------------------
    if (payload.type === 'view_submission') {
      res.status(200).end();

      setTimeout(async () => {
        try {
          const channelId = payload.view.private_metadata;
          const topic =
            payload.view.state.values.topic.topic_input.value;

          const options = [];
          for (let i = 1; i <= 5; i++) {
            const val =
              payload.view.state.values[`opt_${i}`][`input_${i}`].value;
            if (val && val.trim()) options.push(val.trim());
          }

          const blocks = [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: `📊 *${topic}*` },
            },
            { type: 'divider' },
          ];

          options.forEach((opt, i) => {
            blocks.push({
              type: 'section',
              text: { type: 'mrkdwn', text: `*${opt}*` },
              accessory: {
                type: 'button',
                text: { type: 'plain_text', text: '투표' },
                action_id: `vote_${i}`,
                value: opt,
              },
            });
          });

          blocks.push({
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: { type: 'plain_text', text: '결과 보기 및 종료' },
                style: 'danger',
                action_id: 'end_poll',
              },
            ],
          });

          const result = await slackAPI('chat.postMessage', {
            channel: channelId,
            text: topic,
            blocks,
          });

          await kv.hset(`poll:${result.ts}`, {});
        } catch (e) {
          console.error('poll 생성 에러:', e);
        }
      }, 0);

      return;
    }

    // -----------------------------
    // 3. 버튼 클릭
    // -----------------------------
    if (payload.type === 'block_actions') {
      res.status(200).end();

      setTimeout(async () => {
        try {
          const action = payload.actions[0];
          const key = `poll:${payload.message.ts}`;

          // 투표
          if (action.action_id.startsWith('vote_')) {
            await kv.hset(key, {
              [payload.user.id]: action.value,
            });
          }

          // 종료
          if (action.action_id === 'end_poll') {
            const votes = await kv.hgetall(key);
            const tally = {};

            Object.values(votes || {}).forEach((v) => {
              tally[v] = (tally[v] || 0) + 1;
            });

            let text = `📊 *설문 결과*\n\n`;
            for (const [k, v] of Object.entries(tally)) {
              text += `• *${k}*: ${v}표\n`;
            }

            await slackAPI('chat.update', {
              channel: payload.channel.id,
              ts: payload.message.ts,
              text,
            });

            await kv.del(key);
          }
        } catch (e) {
          console.error('action 에러:', e);
        }
      }, 0);

      return;
    }

    res.status(200).end();
  } catch (err) {
    console.error('🔥 전체 에러:', err);
    res.status(500).end();
  }
};

// -----------------------------
module.exports.config = {
  api: {
    bodyParser: false,
  },
};
