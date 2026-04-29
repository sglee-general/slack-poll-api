const { App } = require('@slack/bolt');
const { kv } = require('@vercel/kv');

// ✅ Bolt App (receiver 없음)
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

// -----------------------------
// 1. 슬래시 명령어
// -----------------------------
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
      },
      label: { type: 'plain_text', text: `선택지 ${num}` },
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
            block_id: 'topic_block',
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
  } catch (e) {
    console.error(e);
  }
});

// -----------------------------
// 2. 모달 제출
// -----------------------------
app.view('poll_modal', async ({ ack, view, client }) => {
  await ack(); // 🔥 핵심

  try {
    const channelId = view.private_metadata;
    const topic = view.state.values.topic_block.topic_input.value;

    const options = [];
    for (let i = 1; i <= 5; i++) {
      const val =
        view.state.values[`option_block_${i}`][`option_input_${i}`].value;
      if (val) options.push(val);
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
          text: { type: 'plain_text', text: '종료' },
          action_id: 'end_poll',
          style: 'danger',
        },
      ],
    });

    const res = await client.chat.postMessage({
      channel: channelId,
      text: topic,
      blocks,
    });

    await kv.hset(`poll:${res.ts}`, {});
  } catch (e) {
    console.error(e);
  }
});

// -----------------------------
// 3. 투표
// -----------------------------
app.action(/^vote_/, async ({ ack, body, action }) => {
  await ack();

  try {
    await kv.hset(`poll:${body.message.ts}`, {
      [body.user.id]: action.value,
    });
  } catch (e) {
    console.error(e);
  }
});

// -----------------------------
// 4. 종료
// -----------------------------
app.action('end_poll', async ({ ack, body, client }) => {
  await ack();

  try {
    const votes = await kv.hgetall(`poll:${body.message.ts}`);
    if (!votes) return;

    const tally = {};
    Object.values(votes).forEach(v => {
      tally[v] = (tally[v] || 0) + 1;
    });

    let text = `📊 *설문 결과*\n\n`;
    for (const [k, v] of Object.entries(tally)) {
      text += `• ${k}: ${v}표\n`;
    }

    await client.chat.update({
      channel: body.channel.id,
      ts: body.message.ts,
      text: '종료',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
    });
  } catch (e) {
    console.error(e);
  }
});

// -----------------------------
// 5. Vercel 핸들러
// -----------------------------
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(200).send('OK');
  }

  try {
    await app.processEvent({
      body: req.body,
      headers: req.headers,
    });

    res.status(200).end();
  } catch (e) {
    console.error(e);
    res.status(500).end();
  }
};

module.exports.config = {
  api: {
    bodyParser: false,
  },
};
