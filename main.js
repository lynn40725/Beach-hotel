import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = "https://cebtdwvnfnhlbpbqcirt.supabase.co" ;
const SUPABASE_ANON_KEY = "sb_publishable_9omkoai3Xn4MYhDxTurlqw_ps0QeM0f" ;
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
console.log("SUPABASE_URL =", SUPABASE_URL);
const el = (id) => document.getElementById(id);
const logEl = el("log");

function log(...args) {
  const msg = args.map(a => (typeof a === "string" ? a : JSON.stringify(a, null, 2))).join(" ");
  logEl.textContent = `[${new Date().toLocaleTimeString()}] ${msg}\n` + logEl.textContent;
}

let sessionUser = null;
let currentRoom = null;
let playersChannel = null;
let roomsChannel = null;

// ---------- Auth ----------
async function ensureSignedIn() {
  const { data } = await supabase.auth.getUser();
  if (data?.user) {
    sessionUser = data.user;
    el("authStatus").textContent = `已登入（匿名）: ${sessionUser.id.slice(0, 8)}…`;
    return sessionUser;
  }

  const { data: signInData, error } = await supabase.auth.signInAnonymously();
  if (error) throw error;
  sessionUser = signInData.user;
  el("authStatus").textContent = `已登入（匿名）: ${sessionUser.id.slice(0, 8)}…`;
  return sessionUser;
}

el("btnSignIn").addEventListener("click", async () => {
  try {
    await ensureSignedIn();
    log("匿名登入成功");
  } catch (e) {
    log("匿名登入失敗：", e.message);
  }
});

// ---------- Room ----------
async function createRoom(targetDeadCards) {
  await ensureSignedIn();
  const { data, error } = await supabase
    .from("rooms")
    .insert({
      // room_code 由 trigger 自動產生
      target_dead_cards: targetDeadCards,
      created_by: sessionUser.id
    })
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

async function findRoomByCode(code) {
  await ensureSignedIn();
  const roomCode = code.trim().toUpperCase();

  const { data, error } = await supabase
    .from("rooms")
    .select("*")
    .eq("room_code", roomCode)
    .maybeSingle();
  
console.log("findRoomByCode:", { roomCode, data, error });

  if (error) throw error;
  if (!data) throw new Error("找不到此房號");
  return data;
}

function renderRoomInfo() {
  if (!currentRoom) {
    el("roomInfo").textContent = "尚未進入房間";
    return;
  }
  el("roomInfo").textContent =
    `room_code=${currentRoom.room_code}\n` +
    `room_id=${currentRoom.id}\n` +
    `status=${currentRoom.status}\n` +
    `target_dead_cards=${currentRoom.target_dead_cards}\n` +
    `current_round=${currentRoom.current_round}\n`;
}

// Realtime subscribe room row (讓多開/無痕也會即時更新回合狀態)
async function subscribeRoom(roomId) {
  if (roomsChannel) {
    await supabase.removeChannel(roomsChannel);
    roomsChannel = null;
  }

  roomsChannel = supabase
    .channel(`room:${roomId}`)
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "rooms", filter: `id=eq.${roomId}` },
      (payload) => {
        currentRoom = payload.new;
        renderRoomInfo();
        log("rooms realtime update:", {
          status: currentRoom.status,
          current_round: currentRoom.current_round
        });
      }
    )
    .subscribe((status) => {
      log(`rooms realtime: ${status}`);
    });
}

// ---------- Players ----------
async function getOrCreatePlayer(roomId, name, job, personality) {
  await ensureSignedIn();

  // 先看自己是否已在房間裡（避免重複加入）
  const { data: existing, error: e1 } = await supabase
    .from("players")
    .select("*")
    .eq("room_id", roomId)
    .eq("user_id", sessionUser.id)
    .maybeSingle();

  if (e1) throw e1;
  if (existing) return existing;

  // turn_order / 人數上限 6 的判斷，交給 RPC 在 DB 端原子處理（避免多人同時加入時重複）
if (!sessionUser?.id) {
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error) throw error;
  if (!user) throw new Error("匿名登入尚未完成，請重整後再試");
  sessionUser = user; // 若 sessionUser 是 const，就改用 currentUser 變數
}
  const { data: inserted, error: e3 } = await supabase.rpc("join_room_player", {

  p_room_id: roomId,
  p_user_id: sessionUser.id,
  p_name: name,
  p_job: job,
  p_personality: personality
});

if (e3) {
  console.error("join_room_player failed:", e3);
  throw new Error(`加入失敗：${e3.message}`);
}

return inserted;

}

// ---------- Round ----------
async function startRound() {
  await ensureSignedIn();
  if (!currentRoom?.id) throw new Error("請先建立或加入房間");

  const { data, error } = await supabase.rpc("start_round", {
    p_room_id: currentRoom.id
  });

  if (error) throw error;
  // RPC 回傳 rooms row（或至少 room_id/current_round），這裡直接以回傳更新畫面
  if (data) {
    currentRoom = data;
    renderRoomInfo();
  }
  log("開始回合成功");
}

function renderPlayers(players) {
  const wrap = el("playersList");
  wrap.innerHTML = "";

  if (!players.length) {
    wrap.textContent = "目前沒有玩家";
    return;
  }

  for (const p of players) {
    const div = document.createElement("div");
    div.className = "playerCard";
    div.innerHTML = `
      <div class="playerTop">
        <div class="playerName">${escapeHtml(p.name)}</div>
        <div class="small">順序: ${p.turn_order}</div>
      </div>
      <div class="small">職業：${escapeHtml(p.job || "")}</div>
      <div class="small">個性：${escapeHtml(p.personality || "")}</div>
      <div class="small">嫌疑：${p.suspicion_total}　清白：${p.innocence_total}　測謊剩餘：${p.challenge_left_this_round}</div>
    `;
    wrap.appendChild(div);
  }
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// Realtime subscribe players of room
async function subscribePlayers(roomId) {
  if (playersChannel) {
    await supabase.removeChannel(playersChannel);
    playersChannel = null;
  }

  // 初次拉取
  const { data, error } = await supabase
    .from("players")
    .select("*")
    .eq("room_id", roomId)
    .order("turn_order", { ascending: true });

  if (error) throw error;
  renderPlayers(data);

  playersChannel = supabase
    .channel(`players:${roomId}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "players", filter: `room_id=eq.${roomId}` },
      async () => {
        // 有變更就重新拉一次（最穩、也最簡單）
        const { data: latest, error: e } = await supabase
          .from("players")
          .select("*")
          .eq("room_id", roomId)
          .order("turn_order", { ascending: true });

        if (!e) renderPlayers(latest);
      }
    )
    .subscribe((status) => {
      log(`players realtime: ${status}`);
    });
}

// ---------- UI wiring ----------
el("btnCreateRoom").addEventListener("click", async () => {
  try {
    const targetDeadCards = Number(el("createTargetDead").value || 8);
    const room = await createRoom(targetDeadCards);
    currentRoom = room;
    renderRoomInfo();
    log("建立房間成功，房號：", room.room_code);

    await subscribeRoom(room.id);

    // 建房後你通常會立刻加入（也可以讓它先等朋友）
    el("joinCode").value = room.room_code;
  } catch (e) {
    log("建立房間失敗：", e.message);
  }
});

el("btnJoinRoom").addEventListener("click", async () => {
  try {
    const code = el("joinCode").value;
    const name = el("pName").value.trim();
    const job = el("pJob").value.trim();
    const personality = el("pPersonality").value.trim();

    if (!code.trim()) throw new Error("請輸入房號");
    if (!name) throw new Error("請輸入名字");

    const room = await findRoomByCode(code);
    currentRoom = room;
    renderRoomInfo();

    const player = await getOrCreatePlayer(room.id, name, job, personality);
    log("加入房間成功：", { room_code: room.room_code, player_id: player.id, turn_order: player.turn_order });

    await subscribePlayers(room.id);
  } catch (e) {
    log("加入房間失敗：", e.message);
  }
});

// 開始回合
el("btnStartRound")?.addEventListener("click", async () => {
  try {
    await startRound();
  } catch (e) {
    log("開始回合失敗：", e.message);
  }
});

// 你需要在 HTML 放一顆按鈕：<button id="btnStartRound">開始回合</button>

// ---------- Auto sign-in on load ----------
(async function init() {
  try {
    await ensureSignedIn();
    log("初始化完成：已匿名登入");
  } catch (e) {
    log("初始化失敗：", e.message);
  }
})();
