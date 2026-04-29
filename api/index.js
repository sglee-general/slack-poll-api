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

  if (body.challenge) return res.status(200).send(body.challenge);

  // 1. 명령어 (/설문)
  if (body.command === '/설문') {
    try {
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
      return res.status(200).send("");
    } catch (e) {
      return res.status(200).send("에러: " + e.message);
    }
  }

  // 2. 인터랙션 (투표 버튼, 모달 제출)
  if (body.payload) {
    const payload = JSON.parse(body.payload);

    // [A] 모달 제출 시 설문 메시지 발송
    if (payload.type === 'view_submission') {
      try {
        const values = payload.view.state.values;
        const channelId = payload.view.private_metadata;
        const topic = values.topic.i.value;
        const opt1 = values.b1.i1.value;
        const opt2 = values.b2.i2.value;

        await client.chat.postMessage({
          channel: channelId,
          text: `📊 *설문 시작: ${topic}*`,
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: `*${topic}*` } },
            { type: 'section', text: { type: 'mrkdwn', text: `1️⃣ ${opt1}` }, accessory: { type: 'button', text: { type: 'plain_text', text: '투표' }, value: opt1, action_id: 'v1' } },
            { type: 'section', text: { type: 'mrkdwn', text: `2️⃣ ${opt2}` }, accessory: { type: 'button', text: { type: 'plain_text', text: '투표' }, value: opt2, action_id: 'v2' } },
            { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: '결과 보기 및 종료' }, style: 'danger', action_id: 'end' }] }
          ]
        });
        return res.status(200).json({ response_action: "clear" });
      } catch (e) {
        return res.status(200).send();
      }
    }

    // [B] 버튼 클릭 (투표 및 종료) - 이 부분의 async 처리가 중요합니다!
    if (payload.type === 'block_actions') {
      const action = payload.actions[0];
      const messageTs = payload.message.ts;
      const userId = payload.user.id;

      try {
        // 투표 처리
        if (action.action_id.startsWith('v')) {
          await redis.hset(`poll:${messageTs}`, { [userId]: action.value }); // 104번 라인 에러 해결 포인트
          await client.chat.postEphemeral({
            channel: payload.channel.id,
            user: userId,
            text: `✅ *${action.value}* 에 투표 완료!`
          });
        }

        // 종료 및 결과 보기 처리
        if (action.action_id === 'end') {
          const votes = await redis.hgetall(`poll:${messageTs}`);
          if (votes) {
            const tally = {};
            Object.values(votes).forEach(v => tally[v] = (tally[v] || 0) + 1);
            let resMsg = `📊 *설문 결과*\n\n`;
            for (const [o, c] of Object.entries(tally)) resMsg += `• *${o}*: ${c}표\n`;
            
            await client.chat.update({
              channel: payload.channel.id,
              ts: messageTs,
              blocks: [{ type: 'section', text: { type: 'mrkdwn', text: resMsg } }],
              text: "설문 종료"
            });
          }
        }
        return res.status(200).send();
      } catch (e) {
        console.error(e);
        return res.status(200).send();
      }
    }
  }

  res.status(200).send("");
};
