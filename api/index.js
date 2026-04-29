module.exports = async (req, res) => {
  console.log("요청 들어옴:", req.body);
  
  // 슬랙 URL 검증용 (Challenge)
  if (req.body && req.body.challenge) {
    return res.status(200).send(req.body.challenge);
  }

  // 슬랙 명령어 응답 테스트
  res.status(200).json({
    response_type: "ephemeral",
    text: "서버가 살아있습니다! 이제 경로 문제는 해결되었습니다."
  });
};
