const { App, ExpressReceiver } = require('@slack/bolt');
const { Redis } = require('@upstash/redis');

// 1. Upstash REST API 연결 (환경 변수 이름이 정확히 일치합니다)
const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

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
  await ack(); // 3초 타임아웃 방지 (선 응답)

  try {
    // 선택지 칸을 5개로 분리하여 생성
    const optionBlocks = [1, 2, 3, 4, 5].map(num => ({
      type: 'input',
      block_id: `option_block_${num}`,
      optional: num > 2, // 1, 2번은 필수
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

/** [모달 제출 처리: 투표 메시지 발송] **/
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
      { type: 'divider' },
      ...options.map((opt, i) => ({
        type: 'section',
        text: { type: 'mrkdwn', text: `*${opt}*` },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: '투표' },
          value: opt,
          action_id: `vote_${i}`
        }
      })),
      { type: 'divider' },
      {
        type: 'actions',
        elements: [{
          type: 'button',
          text: { type: 'plain_text', text: '결과 보기 및 종료' },
          style: 'danger',
          action_id: 'end_poll'
        }]
      }
    ];

    await client.chat.postMessage({ channel: channelId, blocks, text: `설문 시작: ${topic}` });
  } catch (e) { console.error(e); }
});

/** [투표 버튼 클릭 처리] **/
app.action(/^vote_/, async ({ ack, body, action }) => {
  await ack();
  // Upstash Redis에 사용자 ID와 선택값 저장
  await redis.hset(`poll:${body.message.ts}`, { [body.user.id]: action.value });
});

/** [종료 버튼 클릭 처리: 결과 집계] **/
app.action('end_poll', async ({ ack, body, client }) => {
  await ack();
  const pollId = body.message.ts;
  const votes = await redis.hgetall(`poll:${pollId}`);
  
  if (!votes) return;

  const tally = {};
  Object.values(votes).forEach(choice => {
    tally[choice] = (tally[choice] || 0) + 1;
  });

  let resultMarkdown = `📊 *설문 종료 결과*\n\n`;
  for (const [choice, count] of Object.entries(tally)) {
    resultMarkdown += `• *${choice}*: ${count}표\n`;
  }

  await client.chat.update({
    channel: body.channel.id,
    ts: pollId,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: resultMarkdown } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `총 ${Object.keys(votes).length}명 참여` }] }
    ],
    text: "설문조사가 종료되었습니다."
  });
});

/** [Vercel 통합 핸들러] **/
module.exports = async (req, res) => {
  if (req.body && req.body.challenge) return res.status(200).send(req.body.challenge);
  if (req.method === 'POST') return await receiver.requestHandler(req, res);
  res.status(200).send('API is Online');
};

module.exports.config = { api: { bodyParser: false } };
