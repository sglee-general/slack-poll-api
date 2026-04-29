const { App } = require('@slack/bolt');
const { kv } = require('@vercel/kv');
const qs = require('querystring');

// ✅ Bolt App
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

// -----------------------------
// 1. /설문 → 모달 열기
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
    console.error('Modal Open Error:', e);
  }
});

// -----------------------------
// 2. 모달 제출 → 설문 생성
// -----------------------------
app.view('poll_modal', async ({ ack, view, client }) => {
  await ack(); // 🔥 가장 중요

  try {
    const channelId = view.private_metadata;
    const topic = view.state.values.topic_block.topic_input.value;

    const options = [];
    for (let i = 1; i <= 5; i++) {
      const val =
        view.state.values[`option_block_${i}`][`option_input_${i}`].value;
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

    const result = await client.chat.postMessage({
      channel: channelId,
      text: topic,
      blocks,
    });

    // Redis 초기화
    await kv.hset(`poll:${result.ts}`, {});
  } catch (e) {
    console.error('Poll Create Error:', e);
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
    console.error('Vote Error:', e);
  }
});

// -----------------------------
// 4. 설문 종료
// -----------------------------
app.action('end_poll', async ({ ack, body, client }) => {
  await ack();

  try {
    const pollKey = `poll:${body.message.ts}`;
    const votes = await kv.hgetall(pollKey);

    if (!votes) return;

    const tally = {};
    Object.values(votes).forEach(v => {
      tally[v] = (tally[v] || 0) + 1;
    });

    let resultText = `📊 *설문 결과*\n\n`;

    for (const [choice, count] of Object.entries(tally)) {
      resultText += `• *${choice}*: ${count}표\n`;
    }

    await client.chat.update({
      channel: body.channel.id,
      ts: body.message.ts,
      text: '설문 종료',
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: resultText },
        },
      ],
    });

    await kv.del(pollKey);
  } catch (e) {
    console.error('End Poll Error:', e);
  }
});

// -----------------------------
// 5. Vercel Handler (🔥 핵심)
// -----------------------------
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(200).send('Slack Poll API Running');
  }

  // 🔥 raw body 읽기
  const buffers = [];
  for await (const chunk of req) {
    buffers.push(chunk);
  }
  const rawBody = Buffer.concat(buffers).toString();

  let body;

  try {
    if (req.headers['content-type']?.includes('application/x-www-form-urlencoded')) {
      const parsed = qs.parse(rawBody);
      body = parsed.payload ? JSON.parse(parsed.payload) : parsed;
    } else {
      body = JSON.parse(rawBody);
    }

    await app.processEvent({
      body,
      headers: req.headers,
    });

    res.status(200).end();
  } catch (e) {
    console.error('Handler Error:', e);
    res.status(500).end();
  }
};

// -----------------------------
// 6. 필수 설정
// -----------------------------
module.exports.config = {
  api: {
    bodyParser: false,
  },
};
