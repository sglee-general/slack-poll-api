const { WebClient } = require('@slack/web-api');
const { Redis } = require('@upstash/redis');
const querystring = require('querystring');

const client = new WebClient(process.env.SLACK_BOT_TOKEN);
const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

// 메인 함수는 반드시 async여야 합니다.
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).send('API Online');

  let body = req.body;
  if (typeof body === 'string' || Buffer.isBuffer(body)) {
    body = querystring.parse(body.toString());
  }

  if (body.challenge) return res.status(200).send(body.challenge);

  // 1. 명령어 처리 (/설문)
  if (body.command === '/설문') {
    try {
      const optionBlocks = [1, 2, 3, 4, 5].map(num => ({
        type: 'input',
        block_id: `b${num}`,
        optional: num > 2,
        element: { type: 'plain_text_input', action_id: `i${num}` },
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
            { type: 'input', block_id: 'topic', element: { type: 'plain_text_input', action_id: 'i' }, label: { type: 'plain_text', text: '주제' } },
            ...optionBlocks
          ],
          submit: { type: 'plain_text', text: '시작' }
        }
      });
      return res.status(200).send("");
    } catch (e) {
      console.error(e);
      return res.status(200).send();
    }
  }

  // 2. 인터랙션 처리 (payload가 있는 경우)
  if (body.payload) {
    const payload = JSON.parse(body.payload);

    // [A] 모달 제출 처리 (설문 메시지 생성)
    if (payload.type === 'view_submission') {
      try {
        const values = payload.view.state.values;
        const channelId = payload.view.private_metadata;
        const topic = values.topic.i.value;
        
        const options = [];
        for (let i = 1; i <= 5; i++) {
          const val = values[`b${i}`][`i${i}`].value;
          if (val && val.trim() !== "") options.push(val.trim());
        }

        const pollBlocks = [
          { type: 'section', text: { type: 'mrkdwn', text: `🔔 *새로운 설문: ${topic}*` } },
          { type: 'divider' }
        ];

        options.forEach((opt, index) => {
          pollBlocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: `*${index + 1}. ${opt}*` },
            accessory: { 
              type: 'button', 
              text: { type: 'plain_text', text: '투표' }, 
              value: opt, 
              action_id: `v${index}` 
            }
          });
        });

        pollBlocks.push({ type: 'divider' });
        pollBlocks.push({
          type: 'actions',
          elements: [{ type: 'button', text: { type: 'plain_text', text: '결과 보기 및 종료' }, style: 'danger', action_id: 'end' }]
        });

        await client.chat.postMessage({
          channel: channelId,
          text: `📊 설문 시작: ${topic}`,
          blocks: pollBlocks
        });

        return res.status(200).json({ response_action: "clear" });
      } catch (e) {
        return res.status(200).send();
      }
    }

    // [B] 버튼 클릭 처리 (투표 및 종료)
    if (payload.type === 'block_actions') {
      try {
        const action = payload.actions[0];
        const messageTs = payload.message.ts;
        const userId = payload.user.id;
        const channelId = payload.channel.id;

        // 투표 처리
        if (action.action_id.startsWith('v')) {
          // 여기서 await를 안전하게 사용할 수 있도록 async 핸들러 내부에 있습니다.
          await redis.hset(`poll:${messageTs}`, { [userId]: action.value });
          await client.chat.postEphemeral({
            channel: channelId,
            user: userId,
            text: `✅ *${action.value}* 에 투표하셨습니다!`
          });
        }

        // 결과 보기 및 종료
        if (action.action_id === 'end') {
          const votes = await redis.hgetall(`poll:${messageTs}`);
          if (votes) {
            const tally = {};
            Object.values(votes).forEach(v => tally[v] = (tally[v] || 0) + 1);
            let resMsg = `📊 *최종 설문 결과*\n\n`;
            for (const [o, c] of Object.entries(tally)) {
              resMsg += `• *${o}*: ${c}표\n`;
            }
            
            await client.chat.update({
              channel: channelId,
              ts: messageTs,
              blocks: [{ type: 'section', text: { type: 'mrkdwn', text: resMsg } }],
              text: "설문 종료"
            });
          }
        }
        return res.status(200).send("");
      } catch (e) {
        console.error(e);
        return res.status(200).send();
      }
    }
  }

  return res.status(200).send("");
};
