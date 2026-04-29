const { App, ExpressReceiver } = require('@slack/bolt');
const { Redis } = require('@upstash/redis');

// 1. Redis 설정 (REST 방식 - 타임아웃 없음)
const redis = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});

// 2. Bolt Receiver 설정
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  processBeforeResponse: true,
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

/** [설문조사 핵심 로직] **/

// /설문 명령어
app.command('/설문', async ({ ack, body, client }) => {
  await ack(); // 즉시 대답해서 3초 타임아웃 방지
  try {
    const optionBlocks = [1, 2, 3, 4, 5].map(num => ({
      type: 'input',
      block_id: `option_block_${num}`,
      optional: num > 2,
      element: { type: 'plain_text_input', action_id: `option_input_${num}` },
      label: { type: 'plain_text', text: `선택지 ${num}` }
    }));

    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'poll_modal',
        private_metadata: body.channel_id,
        title: { type: 'plain_text', text: '📊 설문조사 생성' },
        blocks: [
          {
            type: 'input',
            block_id: 'topic_block',
            element: { type: 'plain_text_input', action_id: 'topic_input' },
            label: { type: 'plain_text', text: '설문 주제' }
          },
          ...optionBlocks
        ],
        submit: { type: 'plain_text', text: '설문 시작' }
      }
    });
  } catch (e) { console.error(e); }
});

// 모달 제출 처리
app.view('poll_modal', async ({ ack, body, view, client }) => {
  await ack();
  try {
    const channelId = view.private_metadata;
    const topic = view.state.values.topic_block.topic_input.value;
    const options = [];
    for (let i = 1; i <= 5; i++) {
      const val = view.state.values[`option_block_${i}`][`option_input_${i}`].value;
      if (val && val.trim() !== '') options.push(val.trim());
    }

    const blocks = [
      { type: 'section', text: { type: 'mrkdwn', text: `🔔 *새로운 설문: ${topic}*` } },
      ...options.map((opt, i) => ({
        type: 'section',
        text: { type: 'mrkdwn', text: `*${opt}*` },
        accessory: { type: 'button', text: { type: 'plain_text', text: '투표' }, value: opt, action_id: `vote_${i}` }
      })),
      { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: '결과 보기' }, style: 'danger', action_id: 'end_poll' }] }
    ];

    await client.chat.postMessage({ channel: channelId, blocks, text: `설문 시작: ${topic}` });
  } catch (e) { console.error(e); }
});

// 투표 및 종료 (Upstash Redis 방식)
app.action(/^vote_/, async ({ ack, body, action }) => {
  await ack();
  await redis.hset(`poll:${body.message.ts}`, { [body.user.id]: action.value });
});

app.action('end_poll', async ({ ack, body, client }) => {
  await ack();
  const votes = await redis.hgetall(`poll:${body.message.ts}`);
  if (!votes) return;
  const tally = {};
  Object.values(votes).forEach(c => tally[c] = (tally[c] || 0) + 1);
  let res = `📊 *설문 결과*\n\n`;
  for (const [c, count] of Object.entries(tally)) res += `• *${c}*: ${count}표\n`;
  await client.chat.update({ channel: body.channel.id, ts: body.message.ts, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: res } }], text: "종료" });
});

/** [3] Vercel 통합 핸들러 (성공했던 구조 유지) **/
module.exports = async (req, res) => {
  // 1. 슬랙 URL 인증(Challenge) 처리
  if (req.body && req.body.challenge) {
    return res.status(200).send(req.body.challenge);
  }

  // 2. POST 요청인 경우에만 Bolt 실행
  if (req.method === 'POST') {
    return await receiver.requestHandler(req, res);
  }

  return res.status(200).send('API is Online');
};

module.exports.config = { api: { bodyParser: false } };
