const { App, ExpressReceiver } = require('@slack/bolt');
const Redis = require('ioredis'); // ioredis로 변경

// 환경 변수에 있는 REDIS_URL을 사용하여 바로 연결합니다.
const redis = new Redis(process.env.REDIS_URL);

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  processBeforeResponse: true,
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

/** [이하 로직 부분 - 데이터 저장 방식만 살짝 수정] **/

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
  } catch (e) { console.error(e); }
});

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

app.action(/^vote_/, async ({ ack, body, action }) => {
  await ack();
  // ioredis 방식의 저장
  await redis.hset(`poll:${body.message.ts}`, body.user.id, action.value);
});

app.action('end_poll', async ({ ack, body, client }) => {
  await ack();
  const votes = await redis.hgetall(`poll:${body.message.ts}`);
  if (!votes || Object.keys(votes).length === 0) return;
  
  const tally = {};
  Object.values(votes).forEach(c => tally[c] = (tally[c] || 0) + 1);
  let res = `📊 *설문 종료 결과*\n\n`;
  for (const [c, count] of Object.entries(tally)) res += `• *${c}*: ${count}표\n`;
  
  await client.chat.update({ 
    channel: body.channel.id, 
    ts: body.message.ts, 
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: res } }], 
    text: "설문 종료" 
  });
});

module.exports = async (req, res) => {
  if (req.body && req.body.challenge) return res.status(200).send(req.body.challenge);
  if (req.method === 'POST') return await receiver.requestHandler(req, res);
  res.status(200).send('API is Online');
};

module.exports.config = { api: { bodyParser: false } };
