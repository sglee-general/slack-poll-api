const { WebClient } = require('@slack/web-api');
const { Redis } = require('@upstash/redis');
const querystring = require('querystring');

const client = new WebClient(process.env.SLACK_BOT_TOKEN);
const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).send('API Online');

  let body = req.body;
  if (typeof body === 'string' || Buffer.isBuffer(body)) {
    body = querystring.parse(body.toString());
  }

  // 1. 슬랙 챌린지 대응
  if (body.challenge) return res.status(200).send(body.challenge);

  // 2. 명령어 (/설문) 처리
  if (body.command === '/설문') {
    try {
      // ★ 중요: 슬랙 API 호출을 먼저 완료할 때까지 기다립니다.
      await client.views.open({
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
      
      // API 호출이 성공한 "후에" 응답을 보냅니다.
      return res.status(200).send(""); 
    } catch (e) {
      console.error("Slack API Error:", e);
      return res.status(200).send("오류 발생: " + e.message);
    }
  }

  // 3. 인터랙션 처리
  if (body.payload) {
    const payload = JSON.parse(body.payload);

    if (payload.type === 'view_submission') {
      try {
        const values = payload.view.state.values;
        const channelId = payload.view.private_metadata;
        const topic = values.topic.i.value;
        const opt1 = values.b1.i1.value;
        const opt2 = values.b2.i2.value;
        const opt3 = values.b3.i3.value;

        // ★ 메시지 전송이 완료될 때까지 기다립니다.
        await client.chat.postMessage({
          channel: channelId,
          text: `📊 *설문 시작: ${topic}*`,
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: `*${topic}*` } },
            { type: 'section', text: { type: 'mrkdwn', text: `1️⃣ ${opt1}` }, accessory: { type: 'button', text: { type: 'plain_text', text: '투표' }, value: opt1, action_id: 'v1' } },
            { type: 'section', text: { type: 'mrkdwn', text: `2️⃣ ${opt2}` }, accessory: { type: 'button', text: { type: 'plain_text', text: '투표' }, value: opt2, action_id: 'v2' } },
            { type: 'section', text: { type: 'mrkdwn', text: `2️⃣ ${opt3}` }, accessory: { type: 'button', text: { type: 'plain_text', text: '투표' }, value: opt3, action_id: 'v2' } },
          ]
        });
        
        // 메시지 전송 후 응답
        return res.status(200).send("");
      } catch (e) {
        console.error("Submission Error:", e);
        return res.status(200).send();
      }
    }
    
    // 투표 버튼 처리
    if (payload.type === 'block_actions') {
      const action = payload.actions[0];
      await redis.hset(`poll:${payload.message.ts}`, { [payload.user.id]: action.value });
      return res.status(200).send("");
    }
  }

  res.status(200).send("");
};

if (payload.type === 'block_actions') {
  const action = payload.actions[0];
  const userId = payload.user.id;
  const channelId = payload.channel.id;
  const messageTs = payload.message.ts;

  try {
    // 1. 투표 버튼 처리 (v1, v2 등)
    if (action.action_id.startsWith('v')) {
      // Redis에 저장
      await redis.hset(`poll:${messageTs}`, { [userId]: action.value });

      // 사용자에게만 보이는 투표 완료 메시지 전송
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: `✅ *${action.value}* 에 투표하셨습니다!`
      });
    }

    // 2. 결과 보기 및 종료 버튼 (end) 처리
    if (action.action_id === 'end') {
      const votes = await redis.hgetall(`poll:${messageTs}`);
      
      if (!votes || Object.keys(votes).length === 0) {
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: "참여자가 없습니다."
        });
        return res.status(200).send();
      }

      const tally = {};
      Object.values(votes).forEach(v => tally[v] = (tally[v] || 0) + 1);
      
      let resMsg = `📊 *최종 설문 결과*\n\n`;
      for (const [opt, count] of Object.entries(tally)) {
        resMsg += `• *${opt}*: ${count}표\n`;
      }

      await client.chat.update({
        channel: channelId,
        ts: messageTs,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: resMsg } }],
        text: "설문 종료"
      });
    }

    return res.status(200).send("");
  } catch (e) {
    console.error("Action Error:", e);
    return res.status(200).send();
  }
}
