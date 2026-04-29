const { App, HTTPReceiver } = require('@slack/bolt');
const { kv } = require('@vercel/kv');

// -----------------------------
// 1. Receiver (🔥 핵심)
// -----------------------------
const receiver = new HTTPReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

// -----------------------------
// 2. App
// -----------------------------
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

// -----------------------------
// 3. /설문 → 모달
// -----------------------------
app.command('/설문', async ({ ack, body, client }) => {
  await ack();

  const optionBlocks = [1, 2, 3, 4, 5].map((n) => ({
    type: 'input',
    block_id: `opt_${n}`,
    optional: n > 2,
    element: {
      type: 'plain_text_input',
      action_id: `input_${n}`,
    },
    label: { type: 'plain_text', text: `선택지 ${n}` },
  }));

  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal',
      callback_id: 'poll_modal',
      private_metadata: body.channel_id,
      title: { type: 'plain_text', text: '📊 설문 생성' },
      submit: { type: 'plain_text', text: '설문 시작' },
      blocks: [
        {
          type: 'input',
          block_id: 'topic',
          element: {
            type: 'plain_text_input',
            action_id: 'topic_input',
          },
          label: { type: 'plain_text', text: '설문 주제' },
        },
        { type: 'divider' },
        ...optionBlocks,
      ],
    },
  });
});

// -----------------------------
// 4. 모달 제출 → 설문 생성
// -----------------------------
app.view('poll_modal', async ({ ack, view, client }) => {
  await ack();

  const channelId = view.private_metadata;
  const topic = view.state.values.topic.topic_input.value;

  const options = [];
  for (let i = 1; i <= 5; i++) {
    const val = view.state.values[`opt_${i}`][`input_${i}`].value;
    if (val && val.trim()) options.push(val.trim());
  }

  const blocks = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `📊 *${topic}*` },
    },
    { type: 'divider' },
  ];

  options.forEach((opt, i) => {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*${opt}*` },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: '투표' },
        action_id: `vote_${i}`,
        value: opt,
      },
    });
  });

  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: '결과 보기 및 종료' },
        style: 'danger',
        action_id: 'end_poll',
      },
    ],
  });

  const res = await client.chat.postMessage({
    channel: channelId,
    text: topic,
    blocks,
  });

  await kv.hset(`poll:${res.ts}`, {});
});

// -----------------------------
// 5. 투표
// -----------------------------
app.action(/^vote_/, async ({ ack, body, action }) => {
  await ack();

  await kv.hset(`poll:${body.message.ts}`, {
    [body.user.id]: action.value,
  });
});

// -----------------------------
// 6. 종료
// -----------------------------
app.action('end_poll', async ({ ack, body, client }) => {
  await ack();

  const key = `poll:${body.message.ts}`;
  const votes = await kv.hgetall(key);

  if (!votes) return;

  const tally = {};
  Object.values(votes).forEach((v) => {
    tally[v] = (tally[v] || 0) + 1;
  });

  let text = `📊 *설문 결과*\n\n`;
  for (const [k, v] of Object.entries(tally)) {
    text += `• *${k}*: ${v}표\n`;
  }

  await client.chat.update({
    channel: body.channel.id,
    ts: body.message.ts,
    text: '설문 종료',
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text },
      },
    ],
  });

  await kv.del(key);
});

// -----------------------------
// 7. Vercel handler
// -----------------------------
module.exports = async (req, res) => {
  return await receiver.requestHandler(req, res);
};

// -----------------------------
// 8. 필수 설정
// -----------------------------
module.exports.config = {
  api: {
    bodyParser: false,
  },
};
