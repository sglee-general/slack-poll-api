const { App, ExpressReceiver } = require('@slack/bolt');

// 1. 보안 키 설정 (Redis 관련 설정은 다 뺐습니다)
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  processBeforeResponse: true,
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

/** [핵심] 오직 /설문 명령어에 '창'만 띄우는 코드 **/
app.command('/설문', async ({ ack, body, client }) => {
  await ack(); // 일단 대답 (3초 방어)

  try {
    // 슬랙아, 이 사람한테 설문지 창 하나만 열어줘!
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        title: { type: 'plain_text', text: '테스트 설문' },
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: '이 창이 보이면 성공입니다!' }
          }
        ],
        submit: { type: 'plain_text', text: '확인' }
      }
    });
    console.log("모달 전송 성공!");
  } catch (error) {
    console.error("모달 전송 에러 로그:", error);
  }
});

// Vercel 핸들러
module.exports = async (req, res) => {
  if (req.method === 'POST') {
    return await receiver.requestHandler(req, res);
  }
  res.status(200).send('서버는 깨어 있습니다.');
};

module.exports.config = { api: { bodyParser: false } };
