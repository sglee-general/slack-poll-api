const { App, ExpressReceiver } = require('@slack/bolt');
const { kv } = require('@vercel/kv');

// 1. Receiver 설정 (Vercel 환경 맞춤)
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  processBeforeResponse: true, // Serverless 환경에서 필수
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

/** [이하 설문조사 로직 - 이전과 동일하지만 경로 수정을 위해 포함] **/

app.command('/설문', async ({ ack, body, client }) => {
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
    console.error(error);
  }
});

// 설문 시작 버튼(모달 제출) 처리
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

  await client.chat.postMessage({ channel: channelId, blocks, text: `설문 시작: ${topic}` });
});

// 투표 및 종료 로직 (생략 - 기존 로직 유지)
app.action(/^vote_/, async ({ ack, body, action }) => { await ack(); await kv.hset(`poll:${body.message.ts}`, { [body.user.id]: action.value }); });
app.action('end_poll', async ({ ack, body, client }) => {
  await ack();
  const votes = await kv.hgetall(`poll:${body.message.ts}`);
  if (!votes) return;
  const tally = {};
  Object.values(votes).forEach(c => tally[c] = (tally[c] || 0) + 1);
  let res = `📊 *결과*\n\n`;
  for (const [c, count] of Object.entries(tally)) res += `• *${c}*: ${count}표\n`;
  await client.chat.update({ channel: body.channel.id, ts: body.message.ts, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: res } }], text: "종료" });
});

// --- Vercel 전용 핸들러 시작 ---
module.exports = async (req, res) => {
  // 슬랙은 POST 요청만 보냅니다.
  if (req.method !== 'POST') {
    return res.status(200).send('Slack Poll API is running!'); 
  }
  
  // Bolt의 핸들러 실행
  return await receiver.requestHandler(req, res);
};

// Vercel이 바디 파싱을 하지 않도록 설정 (Bolt가 직접 파싱해야 함)
export const config = {
  api: {
    bodyParser: false,
  },
};
