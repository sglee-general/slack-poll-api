const { App, ExpressReceiver } = require('@slack/bolt');
const Redis = require('ioredis');

// 1. Redis 설정 (전역 변수로 선언하여 연결 재사용)
let redisCache;
function getRedis() {
  if (!redisCache) {
    redisCache = new Redis(process.env.REDIS_URL, {
      connectTimeout: 5000,
      maxRetriesPerRequest: 1
    });
  }
  return redisCache;
}

// 2. Receiver 설정
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  processBeforeResponse: true, // 서버리스 환경에서 필수
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

/** [핵심 로직] **/

app.command('/설문', async ({ ack, body, client }) => {
  // ★ 중요: 슬랙에게 즉시 대답 (3초 타임아웃 방지)
  await ack(); 

  // 나머지 작업은 비동기로 처리
  try {
    const optionBlocks = [1, 2, 3, 4, 5].map(num => ({
      type: 'input',
      block_id: `option_block_${num}`,
      optional: num > 2,
      element: { 
        type: 'plain_text_input', 
        action_id: `option_input_${num}`,
        placeholder: { type: 'plain_text', text: `선택지 ${num} 입력...` }
      },
      label: { type: 'plain_text', text: `선택지 ${num}` }
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
    console.error("View Open Error:", error);
  }
});

// 모달 제출 처리
app.view('poll_modal', async ({ ack, body, view, client }) => {
  await ack();
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
});

// 투표 저장
app.action(/^vote_/, async ({ ack, body, action }) => {
  await ack();
  const redis = getRedis();
  await redis.hset(`poll:${body.message.ts}`, body.user.id, action.value);
});

// 종료 처리
app.action('end_poll', async ({ ack, body, client }) => {
  await ack();
  const redis = getRedis();
  const votes = await redis.hgetall(`poll:${body.message.ts}`);
  if (!votes || Object.keys(votes).length === 0) return;
  
  const tally = {};
  Object.values(votes).forEach(c => tally[c] = (tally[c] || 0) + 1);
  let res = `📊 *최종 결과*\n\n`;
  for (const [c, count] of Object.entries(tally)) res += `• *${c}*: ${count}표\n`;
  
  await client.chat.update({ 
    channel: body.channel.id, ts: body.message.ts, 
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: res } }], text: "결과" 
  });
});

// 3. Vercel용 통합 핸들러 (중요: 이 형식을 유지해야 404가 안 납니다)
module.exports = async (req, res) => {
  if (req.method === 'POST') {
    // 슬랙 챌린지 대응
    if (req.body && req.body.challenge) {
      return res.status(200).send(req.body.challenge);
    }
    // Bolt 앱 핸들러 실행
    return await receiver.requestHandler(req, res);
  }
  res.status(404).send('Not Found');
};

// Vercel 설정: 바디 파서 비활성화
module.exports.config = {
  api: { bodyParser: false },
};
