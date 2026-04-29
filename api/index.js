const { App, ExpressReceiver } = require('@slack/bolt');
const { Redis } = require('@upstash/redis');

// 1. Redis 설정 (Vercel KV 연동 시 자동으로 들어오는 환경변수 사용)
const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

// 2. 슬랙 Receiver 설정
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  processBeforeResponse: true,
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

/** [핵심 로직: /설문 명령어] **/
app.command('/설문', async ({ ack, body, client }) => {
  // 슬랙은 3초 안에 ack()를 받아야 합니다.
  await ack();
  
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
        title: { type: 'plain_text', text: '📊 설문조사 생성' },
        blocks: [
          {
            type: 'input',
            block_id: 'topic_block',
            element: { type: 'plain_text_input', action_id: 'topic_input' },
            label: { type: 'plain_text', text: '설문 주제' }
          },
          { type: 'divider' },
          ...optionBlocks
        ],
        submit: { type: 'plain_text', text: '설문 시작' }
      }
    });
  } catch (error) {
    console.error("Modal Error:", error);
  }
});

/** [로직: 모달 제출, 투표, 종료 등은 이전과 동일하게 작동하도록 구성] **/
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
    { type: 'divider' }
  ];

  options.forEach((option, index) => {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*${option}*` },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: '투표' },
        value: option,
        action_id: `vote_${index}`
      }
    });
  });

  blocks.push({
    type: 'actions',
    elements: [{ type: 'button', text: { type: 'plain_text', text: '결과 보기 및 종료' }, style: 'danger', action_id: 'end_poll' }]
  });

  await client.chat.postMessage({ channel: channelId, blocks, text: `설문 시작!` });
});

app.action(/^vote_/, async ({ ack, body, action }) => {
  await ack();
  // hset 사용 (Upstash Redis 방식)
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

/** 3. Vercel용 통합 핸들러 (404 방지) **/
module.exports = async (req, res) => {
  // 1. GET 요청 대응 (브라우저에서 주소 쳤을 때 작동 확인용)
  if (req.method === 'GET') {
    return res.status(200).send('슬랙 설문 API가 정상 작동 중입니다!');
  }

  // 2. 슬랙 URL 인증(Challenge) 처리
  if (req.body && req.body.challenge) {
    return res.status(200).send(req.body.challenge);
  }

  // 3. 슬랙 이벤트 처리
  try {
    await receiver.requestHandler(req, res);
  } catch (error) {
    console.error("API Error:", error);
    res.status(500).end();
  }
};

// Vercel 설정
module.exports.config = {
  api: { bodyParser: false },
};
