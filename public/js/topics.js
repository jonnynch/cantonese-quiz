/* Built-in topic packs (Explore). DATA ONLY: each entry is [character, jyutping, compound word, word jyutping]; the compound word always contains the character.
   A topic does not own its characters: when it is first opened, every entry is resolved to the SHARED character record with the same glyph (a curriculum
   level's record if there is one); only an entry that exists nowhere is added, once, to the hidden shared level 主題字庫 under a stable id, so a character
   that belongs to several topics (魚, 水, 日, 月, 食, 家 ...) is ONE record and has ONE set of learning statistics. */
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m; else root.CQTopics = m;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const LIB_LEVEL_ID = 'topic-library', LIB_LEVEL_NAME = '主題字庫';
  const libId = c => 'tc-' + c.codePointAt(0).toString(16);          // stable across devices, so backups of different devices agree
  const PACKS = [
    { id: "animals", zh: "動物", en: "Animals", icon: "🐾", ord: 1, items: [
      ["貓", "maau1", "小貓", "siu2 maau1"],
      ["狗", "gau2", "小狗", "siu2 gau2"],
      ["牛", "ngau4", "黃牛", "wong4 ngau4"],
      ["羊", "joeng4", "山羊", "saan1 joeng4"],
      ["馬", "maa5", "斑馬", "baan1 maa5"],
      ["鳥", "niu5", "小鳥", "siu2 niu5"],
      ["魚", "jyu4", "小魚", "siu2 jyu4"],
      ["兔", "tou3", "白兔", "baak6 tou3"],
      ["熊", "hung4", "熊貓", "hung4 maau1"],
      ["雞", "gai1", "公雞", "gung1 gai1"],
      ["豬", "zyu1", "小豬", "siu2 zyu1"],
      ["蛇", "se4", "小蛇", "siu2 se4"] ] },
    { id: "weather", zh: "天氣", en: "Weather", icon: "☀️", ord: 2, items: [
      ["天", "tin1", "天氣", "tin1 hei3"],
      ["日", "jat6", "日頭", "jat6 tau2"],
      ["月", "jyut6", "月亮", "jyut6 loeng6"],
      ["雨", "jyu5", "下雨", "haa6 jyu5"],
      ["風", "fung1", "大風", "daai6 fung1"],
      ["雪", "syut3", "下雪", "haa6 syut3"],
      ["雲", "wan4", "白雲", "baak6 wan4"],
      ["晴", "cing4", "天晴", "tin1 cing4"],
      ["雷", "leoi4", "打雷", "daa2 leoi4"],
      ["電", "din6", "閃電", "sim2 din6"] ] },
    { id: "food", zh: "食物", en: "Food", icon: "🍚", ord: 3, items: [
      ["食", "sik6", "食飯", "sik6 faan6"],
      ["飯", "faan6", "白飯", "baak6 faan6"],
      ["菜", "coi3", "青菜", "ceng1 coi3"],
      ["肉", "juk6", "豬肉", "zyu1 juk6"],
      ["魚", "jyu4", "小魚", "siu2 jyu4"],
      ["蛋", "daan2", "雞蛋", "gai1 daan2"],
      ["果", "gwo2", "水果", "seoi2 gwo2"],
      ["茶", "caa4", "飲茶", "jam2 caa4"],
      ["水", "seoi2", "清水", "cing1 seoi2"],
      ["糖", "tong4", "糖果", "tong4 gwo2"] ] },
    { id: "family", zh: "家庭", en: "Family", icon: "👨‍👩‍👧", ord: 4, items: [
      ["爸", "baa1", "爸爸", "baa4 baa1"],
      ["媽", "maa1", "媽媽", "maa4 maa1"],
      ["哥", "go1", "哥哥", "go4 go1"],
      ["姐", "ze2", "姐姐", "ze4 ze2"],
      ["弟", "dai6", "弟弟", "dai6 dai2"],
      ["妹", "mui6", "妹妹", "mui6 mui2"],
      ["家", "gaa1", "家人", "gaa1 jan4"],
      ["人", "jan4", "大人", "daai6 jan4"] ] },
    { id: "body", zh: "身體", en: "Body", icon: "🧍", ord: 5, items: [
      ["眼", "ngaan5", "眼睛", "ngaan5 zing1"],
      ["耳", "ji5", "耳仔", "ji5 zai2"],
      ["口", "hau2", "開口", "hoi1 hau2"],
      ["鼻", "bei6", "鼻子", "bei6 zi2"],
      ["手", "sau2", "雙手", "soeng1 sau2"],
      ["腳", "goek3", "手腳", "sau2 goek3"],
      ["頭", "tau4", "頭髮", "tau4 faat3"],
      ["身", "san1", "身體", "san1 tai2"] ] },
    { id: "colours", zh: "顏色", en: "Colours", icon: "🎨", ord: 6, items: [
      ["紅", "hung4", "紅色", "hung4 sik1"],
      ["黃", "wong4", "黃色", "wong4 sik1"],
      ["藍", "laam4", "藍色", "laam4 sik1"],
      ["綠", "luk6", "綠色", "luk6 sik1"],
      ["白", "baak6", "白色", "baak6 sik1"],
      ["黑", "hak1", "黑色", "hak1 sik1"],
      ["紫", "zi2", "紫色", "zi2 sik1"] ] },
    { id: "numbers", zh: "數字", en: "Numbers", icon: "🔢", ord: 7, items: [
      ["一", "jat1", "一個", "jat1 go3"],
      ["二", "ji6", "第二", "dai6 ji6"],
      ["三", "saam1", "三個", "saam1 go3"],
      ["四", "sei3", "四個", "sei3 go3"],
      ["五", "ng5", "五個", "ng5 go3"],
      ["六", "luk6", "六個", "luk6 go3"],
      ["七", "cat1", "七個", "cat1 go3"],
      ["八", "baat3", "八個", "baat3 go3"],
      ["九", "gau2", "九個", "gau2 go3"],
      ["十", "sap6", "十個", "sap6 go3"],
      ["百", "baak3", "一百", "jat1 baak3"] ] },
    { id: "transport", zh: "交通", en: "Transport", icon: "🚌", ord: 8, items: [
      ["車", "ce1", "汽車", "hei3 ce1"],
      ["船", "syun4", "輪船", "leon4 syun4"],
      ["飛", "fei1", "飛機", "fei1 gei1"],
      ["路", "lou6", "馬路", "maa5 lou6"],
      ["巴", "baa1", "巴士", "baa1 si2"],
      ["鐵", "tit3", "地鐵", "dei6 tit3"] ] },
    { id: "school", zh: "學校", en: "School", icon: "🏫", ord: 9, items: [
      ["書", "syu1", "書包", "syu1 baau1"],
      ["筆", "bat1", "鉛筆", "jyun4 bat1"],
      ["學", "hok6", "上學", "soeng5 hok6"],
      ["校", "haau6", "學校", "hok6 haau6"],
      ["師", "si1", "老師", "lou5 si1"],
      ["生", "saang1", "學生", "hok6 saang1"] ] },
    { id: "nature", zh: "自然", en: "Nature", icon: "🌳", ord: 10, items: [
      ["山", "saan1", "高山", "gou1 saan1"],
      ["水", "seoi2", "清水", "cing1 seoi2"],
      ["花", "faa1", "鮮花", "sin1 faa1"],
      ["草", "cou2", "青草", "ceng1 cou2"],
      ["樹", "syu6", "大樹", "daai6 syu6"],
      ["石", "sek6", "石頭", "sek6 tau4"],
      ["海", "hoi2", "大海", "daai6 hoi2"] ] },
    { id: "home", zh: "屋企", en: "Home", icon: "🏠", ord: 11, items: [
      ["門", "mun4", "大門", "daai6 mun4"],
      ["窗", "coeng1", "窗戶", "coeng1 wu6"],
      ["床", "cong4", "起床", "hei2 cong4"],
      ["椅", "ji2", "椅子", "ji2 zi2"],
      ["桌", "zoek3", "桌子", "zoek3 zi2"],
      ["屋", "uk1", "屋企", "uk1 kei2"],
      ["家", "gaa1", "家人", "gaa1 jan4"] ] },
    { id: "actions", zh: "動作", en: "Actions", icon: "🏃", ord: 12, items: [
      ["行", "haang4", "行路", "haang4 lou6"],
      ["走", "zau2", "走路", "zau2 lou6"],
      ["食", "sik6", "食飯", "sik6 faan6"],
      ["飲", "jam2", "飲水", "jam2 seoi2"],
      ["睇", "tai2", "睇書", "tai2 syu1"],
      ["聽", "teng1", "聽歌", "teng1 go1"],
      ["講", "gong2", "講話", "gong2 waa6"],
      ["玩", "waan2", "好玩", "hou2 waan2"] ] },
    { id: "emotions", zh: "情緒", en: "Emotions", icon: "😊", ord: 13, items: [
      ["開", "hoi1", "開心", "hoi1 sam1"],
      ["心", "sam1", "開心", "hoi1 sam1"],
      ["笑", "siu3", "微笑", "mei4 siu3"],
      ["哭", "huk1", "大哭", "daai6 huk1"],
      ["怕", "paa3", "害怕", "hoi6 paa3"],
      ["愛", "oi3", "愛心", "oi3 sam1"],
      ["喜", "hei2", "喜歡", "hei2 fun1"] ] },
    { id: "time", zh: "時間", en: "Time", icon: "⏰", ord: 14, items: [
      ["日", "jat6", "日頭", "jat6 tau2"],
      ["月", "jyut6", "月亮", "jyut6 loeng6"],
      ["年", "nin4", "今年", "gam1 nin4"],
      ["早", "zou2", "早上", "zou2 soeng6"],
      ["晚", "maan5", "晚上", "maan5 soeng6"],
      ["今", "gam1", "今日", "gam1 jat6"],
      ["明", "ming4", "明天", "ming4 tin1"],
      ["時", "si4", "時間", "si4 gaan3"] ] },
  ];
  return { PACKS, LIB_LEVEL_ID, LIB_LEVEL_NAME, libId };
});
