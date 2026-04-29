const { App, ExpressReceiver } = require('@slack/bolt');

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  processBeforeResponse: true,
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

// "/설문" 명령어 처리
app.command('/설문', async ({ ack, body, client }) => {
  await ack();
  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal',
      callback_id: 'poll_modal',
      title: { type: 'plain_text', text: '설문조사 생성' },
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
          element: { type: 'plain_text_input', multiline: true, action_id: 'options_input', placeholder: { type: 'plain_text', text: '선택지를 줄바꿈으로 구분해 입력하세요.' } },
          label: { type: 'plain_text', text: '선택지' }
        }
      ],
      submit: { type: 'plain_text', text: '적용' }
    }
  });
});

// Vercel이 실행할 수 있도록 내보내기
module.exports = async (req, res) => {
  if (req.method === 'POST') {
    await receiver.requestHandler(req, res);
  } else {
    res.status(404).send('Not Found');
  }
};
