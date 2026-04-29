const { App, ExpressReceiver } = require('@slack/bolt');
const { kv } = require('@vercel/kv');

// 1. Receiver 설정 - 엔드포인트를 Vercel 경로에 맞게 명시적으로 지정
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  // Vercel의 /api 경로와 일치시킵니다.
  endpoints: {
    events: '/api',
    interactive: '/api',
  },
  processBeforeResponse: true,
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

/** 2. 로직 부분 (기존과 동일) **/

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
    console.error("Modal Open Error:", error);
  }
});

// 설문 시작 버튼(모달 제출) 처리
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
  } catch (error) {
    console.error("Post Message Error:", error);
  }
});

// 투표 버튼 처리
app.action(/^vote_/, async ({ ack, body, action }) => {
  await ack();
  try {
    await kv.hset(`poll:${body.message.ts}`, { [body.user.id]: action.value });
  } catch (e) { console.error("KV Error:", e); }
});

// 설문 종료 처리
app.action('end_poll', async ({ ack, body, client }) => {
  await ack();
  try {
    const votes = await kv.hgetall(`poll:${body.message.ts}`);
    if (!votes) return;
    const tally = {};
    Object.values(votes).forEach(c => tally[c] = (tally[c] || 0) + 1);
    let res = `📊 *설문 결과*\n\n`;
    for (const [c, count] of Object.entries(tally)) res += `• *${c}*: ${count}표\n`;
    await client.chat.update({ 
      channel: body.channel.id, 
      ts: body.message.ts, 
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: res } }], 
      text: "설문 종료" 
    });
  } catch (e) { console.error("End Poll Error:", e); }
});

// 3. Vercel용 핸들러 수동 내보내기
module.exports = async (req, res) => {
  // 슬랙은 POST로만 옵니다. GET 등으로 접속 시 서버 생존 확인용 응답
  if (req.method !== 'POST') {
    return res.status(200).send('Slack Poll API is active.');
  }
  
  // Bolt Receiver 실행
  return await receiver.requestHandler(req, res);
};

// Vercel 설정 - 바디 파서 비활성화 (매우 중요)
module.exports.config = {
  api: {
    bodyParser: false,
  },
};
