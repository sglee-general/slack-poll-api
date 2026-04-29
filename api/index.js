const { App, ExpressReceiver } = require('@slack/bolt');
const { kv } = require('@vercel/kv'); // 투표 저장을 위한 데이터베이스

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  processBeforeResponse: true,
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

// 1. "/설문" 입력 시 모달 팝업
app.command('/설문', async ({ ack, body, client }) => {
  await ack();
  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal',
      callback_id: 'poll_modal',
      title: { type: 'plain_text', text: '📊 설문조사 생성' },
      blocks: [
        {
          type: 'input',
          block_id: 'topic_block',
          element: { type: 'plain_text_input', action_id: 'topic_input' },
          label: { type: 'plain_text', text: '설문 주제' }
        },
        {
          type: 'input',
          block_id: 'options_block',
          element: { 
            type: 'plain_text_input', 
            multiline: true, 
            action_id: 'options_input', 
            placeholder: { type: 'plain_text', text: '선택지를 줄바꿈으로 구분해 입력하세요.' } 
          },
          label: { type: 'plain_text', text: '선택지' }
        }
      ],
      submit: { type: 'plain_text', text: '설문 시작' }
    }
  });
});

// 2. 모달에서 "설문 시작" 클릭 시 채널에 메시지 게시
app.view('poll_modal', async ({ ack, body, view, client }) => {
  await ack();
  
  const topic = view.state.values.topic_block.topic_input.value;
  const options = view.state.values.options_block.options_input.value.split('\n').filter(o => o.trim() !== '');

  // 투표 메시지 구성
  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: `🔔 *새로운 설문조사: ${topic}*` } },
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
        action_id: `vote_button_${index}`
      }
    });
  });

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'actions',
    elements: [{
      type: 'button',
      text: { type: 'plain_text', text: '결과 보기 및 종료' },
      style: 'danger',
      action_id: 'end_poll'
    }]
  });

  // 설문을 호출한 채널(또는 지정된 채널)에 전송
  await client.chat.postMessage({
    channel: body.user.id, // 테스트를 위해 우선 DM으로 발송 (실제 채널 ID로 변경 가능)
    blocks: blocks,
    text: `설문: ${topic}`
  });
});

// 3. 투표 버튼 클릭 시 처리 (Vercel KV에 저장)
app.action(/^vote_button_/, async ({ ack, body, action, client }) => {
  await ack();
  const pollId = body.message.ts; // 메시지의 타임스탬프를 설문 ID로 사용
  const userId = body.user.id;
  const selectedOption = action.value;

  // Redis(KV)에 유저별 선택 저장 (중복 투표 시 덮어쓰기)
  await kv.hset(`poll:${pollId}`, { [userId]: selectedOption });

  // 유저에게만 보이는 확인 메시지 (임시)
  console.log(`${userId}님이 ${selectedOption}에 투표함`);
});

// 4. "결과 보기" 클릭 시 집계 후 결과 전송
app.action('end_poll', async ({ ack, body, client }) => {
  await ack();
  const pollId = body.message.ts;
  
  // 모든 투표 데이터 가져오기
  const votes = await kv.hgetall(`poll:${pollId}`);
  
  if (!votes) {
    return await client.chat.postMessage({ channel: body.channel.id, text: "투표 데이터가 없습니다." });
  }

  // 결과 집계
  const stats = {};
  Object.values(votes).forEach(opt => {
    stats[opt] = (stats[opt] || 0) + 1;
  });

  let resultText = "📊 *설문조사 결과 발표* \n\n";
  for (const [opt, count] of Object.entries(stats)) {
    resultText += `• *${opt}*: ${count}표\n`;
  }

  await client.chat.update({
    channel: body.channel.id,
    ts: pollId,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: resultText } }
    ],
    text: "설문이 종료되었습니다."
  });
});

// Vercel Serverless Function 핸들러
module.exports = async (req, res) => {
  if (req.method === 'POST') {
    await receiver.requestHandler(req, res);
  } else {
    res.status(404).send('Not Found');
  }
};
