const { WebClient } = require('@slack/web-api');
const { Redis } = require('@upstash/redis');
const querystring = require('querystring');

// 1. 초기화 (라이브러리만 사용하고 Bolt의 복잡한 리시버는 건너뜁니다)
const client = new WebClient(process.env.SLACK_BOT_TOKEN);
const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

module.exports = async (req, res) => {
  // POST가 아니면 무시
  if (req.method !== 'POST') return res.status(200).send('API Online');

  // Vercel이 파싱한 바디 가져오기
  const body = req.body;

  // [A] 슬랙 챌린지 (최초 연결용)
  if (body.challenge) return res.status(200).send(body.challenge);

  // [B] 슬래시 명령어 (/설문) 처리
  if (body.command === '/설문') {
    res.status(200).send(); // 0.1초 만에 응답해서 타임아웃 방지
    
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
            ...[1, 2, 3, 4, 5].map(n => ({
              type: 'input', block_id: `b${n}`, optional: n > 2,
              element: { type: 'plain_text_input', action_id: `i${n}` },
              label: { type: 'plain_text', text: `선택지 ${n}` }
            }))
          ],
          submit: { type: 'plain_text', text: '시작' }
        }
      });
    } catch (e) { console.error("Modal Error:", e); }
    return;
  }

  // [C] 인터랙션 (모달 제출, 투표 버튼 등) 처리
  if (body.payload) {
    const payload = JSON.parse(body.payload);
    
    // 즉시 응답 (슬랙의 3초 타임아웃을 물리적으로 차단)
    res.status(200).send();

    // 1. 모달 제출 (설문 시작)
    if (payload.type === 'view_submission' && payload.view.callback_id === 'poll_modal') {
      const channelId = payload.view.private_metadata;
      const values = payload.view.state.values;
      const topic = values.topic.i.value;
      const options = [];
      for (let i = 1; i <= 5; i++) {
        const val = values[`b${i}`][`i${i}`].value;
        if (val) options.push(val);
      }

      const blocks = [
        { type: 'section', text: { type: 'mrkdwn', text: `🔔 *새 설문: ${topic}*` } },
        ...options.map((opt, i) => ({
          type: 'section', text: { type: 'mrkdwn', text: `*${opt}*` },
          accessory: { type: 'button', text: { type: 'plain_text', text: '투표' }, value: opt, action_id: `v_${i}` }
        })),
        { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: '종료' }, style: 'danger', action_id: 'end' }] }
      ];

      await client.chat.postMessage({ channel: channelId, blocks, text: topic });
    }

    // 2. 투표 버튼 클릭
    if (payload.type === 'block_actions' && payload.actions[0].action_id.startsWith('v_')) {
      const action = payload.actions[0];
      await redis.hset(`poll:${payload.message.ts}`, { [payload.user.id]: action.value });
    }

    // 3. 종료 버튼 클릭
    if (payload.type === 'block_actions' && payload.actions[0].action_id === 'end') {
      const votes = await redis.hgetall(`poll:${payload.message.ts}`);
      if (!votes) return;
      const tally = {};
      Object.values(votes).forEach(v => tally[v] = (tally[v] || 0) + 1);
      let resMsg = `📊 *결과*\n\n`;
      for (const [o, c] of Object.entries(tally)) resMsg += `• *${o}*: ${c}표\n`;
      await client.chat.update({ channel: payload.channel.id, ts: payload.message.ts, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: resMsg } }], text: "종료" });
    }
  }
};
