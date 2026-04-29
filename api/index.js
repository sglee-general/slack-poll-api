const { WebClient } = require('@slack/web-api');
const { Redis } = require('@upstash/redis');
const querystring = require('querystring');

const client = new WebClient(process.env.SLACK_BOT_TOKEN);
const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

module.exports = async (req, res) => {
  // 1. 접속 로그 (Vercel 로그에서 확인 가능)
  console.log("--- 새로운 요청 발생 ---");
  console.log("메소드:", req.method);

  if (req.method !== 'POST') return res.status(200).send('API Online');

  // 2. 데이터 파싱 (Vercel 환경에 맞게 수동 파싱)
  let body = req.body;
  if (typeof body === 'string' || Buffer.isBuffer(body)) {
    body = querystring.parse(body.toString());
  }

  // 3. 슬랙 챌린지 대응
  if (body.challenge) {
    console.log("Challenge 요청 처리");
    return res.status(200).send(body.challenge);
  }

  // 4. 명령어(/설문) 처리
  if (body.command === '/설문') {
    console.log("명령어 인식됨: /설문");
    
    try {
      const result = await client.views.open({
        trigger_id: body.trigger_id,
        view: {
          type: 'modal',
          callback_id: 'poll_modal',
          private_metadata: body.channel_id,
          title: { type: 'plain_text', text: '📊 설문조사' },
          blocks: [
            { type: 'input', block_id: 'topic', element: { type: 'plain_text_input', action_id: 'i' }, label: { type: 'plain_text', text: '주제' } },
            { type: 'input', block_id: 'b1', element: { type: 'plain_text_input', action_id: 'i1' }, label: { type: 'plain_text', text: '선택지 1' } },
            { type: 'input', block_id: 'b2', element: { type: 'plain_text_input', action_id: 'i2' }, label: { type: 'plain_text', text: '선택지 2' } }
          ],
          submit: { type: 'plain_text', text: '시작' }
        }
      });
      console.log("모달 전송 성공");
      return res.status(200).send(""); // 성공 응답
    } catch (e) {
      console.error("모달 전송 실패 에러:", e.data ? JSON.stringify(e.data) : e.message);
      return res.status(200).send("에러가 발생했습니다: " + e.message);
    }
  }

  // 5. 인터랙션 (확인 버튼 등) 처리
  if (body.payload) {
    const payload = JSON.parse(body.payload);
    console.log("인터랙션 타입:", payload.type);

    if (payload.type === 'view_submission') {
      const channelId = payload.view.private_metadata;
      const topic = payload.view.state.values.topic.i.value;
      const opt1 = payload.view.state.values.b1.i1.value;
      const opt2 = payload.view.state.values.b2.i2.value;

      await client.chat.postMessage({
        channel: channelId,
        text: `📊 *설문 시작: ${topic}*`,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `*${topic}*` } },
          { type: 'section', text: { type: 'mrkdwn', text: `1️⃣ ${opt1}` }, accessory: { type: 'button', text: { type: 'plain_text', text: '투표' }, value: opt1, action_id: 'v1' } },
          { type: 'section', text: { type: 'mrkdwn', text: `2️⃣ ${opt2}` }, accessory: { type: 'button', text: { type: 'plain_text', text: '투표' }, value: opt2, action_id: 'v2' } }
        ]
      });
      return res.status(200).send("");
    }
  }

  console.log("처리되지 않은 요청");
  res.status(200).send("");
};
