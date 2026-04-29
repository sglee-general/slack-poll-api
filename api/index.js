const { App, ExpressReceiver } = require('@slack/bolt');
const Redis = require('ioredis');

// 1. Receiver 설정 - processBeforeResponse: true로 선 응답 보장
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  processBeforeResponse: true, 
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

// Redis는 전역 변수로 관리하되, 필요할 때만 연결 (최초 부팅 속도 향상)
let redis;
function getRedis() {
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL, {
      connectTimeout: 5000,
      maxRetriesPerRequest: 1
    });
  }
  return redis;
}

/** [1] /설문 명령어 - 즉각적인 ack 처리 **/
app.command('/설문', async ({ ack, body, client }) => {
  // ★ 최우선 작업: 슬랙에 0.1초 만에 응답 보내기
  await ack(); 

  // 이후 작업은 비동기로 진행 (await를 하더라도 ack가 먼저 전송됨)
  try {
    const optionBlocks = [1, 2, 3, 4, 5].map(num => ({
      type: 'input',
      block_id: `option_block_${num}`,
      optional: num > 2,
      element: { type: 'plain_text_input', action_id: `option_input_${num}` },
      label: { type: 'plain_text', text: `선택지 ${num}${num > 2 ? ' (옵션)' : ''}` }
    }));

    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'poll_modal',
        private_metadata: body.channel_id,
        title: { type: 'plain_text', text: '📊 설문조사' },
        blocks: [
          {
            type: 'input',
            block_id: 'topic_block',
            element: { type: 'plain_text_input', action_id: 'topic_input' },
            label: { type: 'plain_text', text: '주제' }
          },
          ...optionBlocks
        ],
        submit: { type: 'plain_text', text: '시작' }
      }
    });
  } catch (error) {
    console.error("모달 열기 실패:", error);
  }
});

/** [2] 모달 제출 및 투표 로직 (생략 - 이전과 동일하되 ack()는 항상 최상단에!) **/
app.view('poll_modal', async ({ ack, body, view, client }) => {
  await ack(); // 즉시 응답
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
      { type: 'divider' },
      ...options.map((opt, i) => ({
        type: 'section',
        text: { type: 'mrkdwn', text: `*${opt}*` },
        accessory: { type: 'button', text: { type: 'plain_text', text: '투표' }, value: opt, action_id: `vote_${i}` }
      })),
      { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: '종료' }, style: 'danger', action_id: 'end_poll' }] }
    ];

    await client.chat.postMessage({ channel: channelId, blocks, text: `설문 시작: ${topic}` });
  } catch (e) { console.error(e); }
});

app.action(/^vote_/, async ({ ack, body, action }) => {
  await ack();
  const r = getRedis();
  await r.hset(`poll:${body.message.ts}`, body.user.id, action.value);
});

app.action('end_poll', async ({ ack, body, client }) => {
  await ack();
  const r = getRedis();
  const votes = await r.hgetall(`poll:${body.message.ts}`);
  if (!votes || Object.keys(votes).length === 0) return;
  const tally = {};
  Object.values(votes).forEach(c => tally[c] = (tally[c] || 0) + 1);
  let res = `📊 *최종 결과*\n\n`;
  for (const [c, count] of Object.entries(tally)) res += `• *${c}*: ${count}표\n`;
  await client.chat.update({ channel: body.channel.id, ts: body.message.ts, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: res } }], text: "결과" });
});

/** [3] Vercel 통합 핸들러 (404 방지를 위해 경로를 수동으로 잡아줌) **/
module.exports = async (req, res) => {
  // 1. 슬랙 인증(Challenge) 처리
  if (req.body && req.body.challenge) {
    return res.status(200).send(req.body.challenge);
  }

  // 2. POST 요청만 처리 (Slash Commands, Interactivity)
  if (req.method === 'POST') {
    return await receiver.requestHandler(req, res);
  }

  // 3. GET 요청 시 상태 표시 (디버깅용)
  return res.status(200).send('API is active and ready!');
};

module.exports.config = { api: { bodyParser: false } };
