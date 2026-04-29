const { App, ExpressReceiver } = require('@slack/bolt');
const { kv } = require('@vercel/kv');

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  processBeforeResponse: true,
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

/**
 * 1. "/설문" 명령어 처리 - 모달 띄우기 (선택지 칸 분리형)
 */
app.command('/설문', async ({ ack, body, client }) => {
  await ack();

  // 선택지 입력 칸 5개 생성
  const optionBlocks = [1, 2, 3, 4, 5].map(num => ({
    type: 'input',
    block_id: `option_block_${num}`,
    optional: num > 2, // 1, 2번은 필수, 나머지는 선택사항
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
      // 어떤 채널에서 명령어를 쳤는지 저장 (나중에 메시지를 보낼 때 필요)
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
});

/**
 * 2. 모달 제출 처리 - 채널에 투표 메시지 게시
 */
app.view('poll_modal', async ({ ack, body, view, client }) => {
  await ack();
  
  const channelId = view.private_metadata; // 아까 저장한 채널 ID
  const topic = view.state.values.topic_block.topic_input.value;
  
  // 입력된 선택지들만 수집
  const options = [];
  for (let i = 1; i <= 5; i++) {
    const val = view.state.values[`option_block_${i}`][`option_input_${i}`].value;
    if (val && val.trim() !== '') {
      options.push(val.trim());
    }
  }

  // 투표 메시지 Block Kit 구성
  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: `🔔 *새로운 설문: ${topic}*` } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `작성자: <@${body.user.id}>` }] },
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

  await client.chat.postMessage({
    channel: channelId,
    blocks: blocks,
    text: `설문 시작: ${topic}`
  });
});

/**
 * 3. 투표 버튼 클릭 처리 - Redis(Vercel KV)에 저장
 */
app.action(/^vote_/, async ({ ack, body, action }) => {
  await ack();
  const pollId = body.message.ts;
  const userId = body.user.id;
  const choice = action.value;

  // 유저의 투표 기록 저장 (중복 투표 시 업데이트됨)
  await kv.hset(`poll:${pollId}`, { [userId]: choice });
});

/**
 * 4. 종료 버튼 처리 - 결과 집계 및 메시지 업데이트
 */
app.action('end_poll', async ({ ack, body, client }) => {
  await ack();
  const pollId = body.message.ts;
  
  const votes = await kv.hgetall(`poll:${pollId}`);
  
  if (!votes) {
    return await client.chat.postMessage({ channel: body.channel.id, text: "투표 참여자가 없습니다." });
  }

  // 투표 결과 계산
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

// Vercel Serverless Function 배포를 위한 핸들러
module.exports = async (req, res) => {
  if (req.method === 'POST') {
    await receiver.requestHandler(req, res);
  } else {
    res.status(404).send('Not Found');
  }
};
