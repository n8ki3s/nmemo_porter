"use strict";

const MEMO_URL = "https://memo.naver.com/?viewType=LIST";
const IMPORTED_KEY_PREFIX = "naverMemoImported:";
const IMPORT_DELAY_MS = 500;

const fileInput = document.getElementById("fileInput");
const keepMetaInput = document.getElementById("keepMeta");
const skipImportedInput = document.getElementById("skipImported");
const userIdInput = document.getElementById("userId");
const preview = document.getElementById("preview");
const previewSummary = document.getElementById("previewSummary");
const previewList = document.getElementById("previewList");
const testButton = document.getElementById("testButton");
const importButton = document.getElementById("importButton");
const stopButton = document.getElementById("stopButton");
const statusEl = document.getElementById("status");

let parsedMemos = [];
let running = false;
let stopRequested = false;

const historyCountEl = document.getElementById("historyCount");
const clearHistoryButton = document.getElementById("clearHistoryButton");

clearHistoryButton.addEventListener("click", () => {
  const count = importedKeys().length;
  if (!count || running) {
    return;
  }
  if (!window.confirm(`가져온 기록 ${count}개를 지울까요?\n네이버 메모는 지워지지 않고, 다음 가져오기에서 이 메모들도 다시 가져오게 됩니다.`)) {
    return;
  }
  try {
    for (const key of importedKeys()) {
      localStorage.removeItem(key);
    }
  } catch (_) {
    // 지우지 못한 기록은 남아 있습니다.
  }
  renderPreview();
  setStatus("가져온 기록을 지웠습니다.", "ok");
});

fileInput.addEventListener("change", loadFiles);
skipImportedInput.addEventListener("change", renderPreview);
testButton.addEventListener("click", () => runImport(1));
importButton.addEventListener("click", () => runImport(Infinity));
stopButton.addEventListener("click", () => {
  stopRequested = true;
  setStatus("현재 메모까지만 만들고 멈춥니다...", "warn");
});

renderPreview();

window.addEventListener("beforeunload", (event) => {
  if (running) {
    event.preventDefault();
    event.returnValue = "";
  }
});

async function loadFiles() {
  parsedMemos = [];
  renderPreview();
  const files = Array.from(fileInput.files || []);
  if (!files.length) {
    return;
  }

  setStatus("파일을 읽는 중입니다...", "");
  const collected = [];
  const errors = [];

  for (const file of files) {
    try {
      if (/\.zip$/i.test(file.name)) {
        const entries = await MemoParser.readZipMarkdownEntries(await file.arrayBuffer());
        for (const entry of entries) {
          try {
            collected.push(...MemoParser.parseMemoMarkdown(entry.text, entry.name));
          } catch (error) {
            errors.push(error.message || String(error));
          }
        }
      } else {
        collected.push(...MemoParser.parseMemoMarkdown(await file.text(), file.name));
      }
    } catch (error) {
      errors.push(error.message || String(error));
    }
  }

  parsedMemos = MemoParser.orderForImport(collected);
  renderPreview();

  if (errors.length) {
    setStatus(errors.join("\n"), parsedMemos.length ? "warn" : "error");
  } else if (!parsedMemos.length) {
    setStatus("가져올 메모를 찾지 못했습니다.", "error");
  } else {
    setStatus("먼저 '1개만 먼저 테스트'로 결과를 확인해 보세요.", "");
  }
}

function pendingMemos() {
  if (!skipImportedInput.checked) {
    return parsedMemos;
  }
  return parsedMemos.filter((memo) => !wasImported(memo));
}

function renderPreview() {
  const pending = pendingMemos();
  const skipped = parsedMemos.length - pending.length;
  preview.classList.toggle("hidden", !parsedMemos.length);
  previewSummary.textContent = `메모 ${parsedMemos.length}개 찾음`
    + (skipped ? ` · 이미 가져온 ${skipped}개 제외` : "")
    + ` · 가져올 메모 ${pending.length}개`;

  previewList.textContent = "";
  for (const memo of pending.slice(0, 50)) {
    const item = document.createElement("li");
    item.textContent = memo.title || firstLine(memo.content) || "(제목 없음)";
    previewList.append(item);
  }
  if (pending.length > 50) {
    const item = document.createElement("li");
    item.textContent = `... 외 ${pending.length - 50}개`;
    previewList.append(item);
  }

  const historyCount = importedKeys().length;
  historyCountEl.textContent = String(historyCount);
  clearHistoryButton.disabled = running || !historyCount;

  const canRun = !running && pending.length > 0;
  testButton.disabled = !canRun;
  importButton.disabled = !canRun;
}

async function runImport(limit) {
  const targets = pendingMemos().slice(0, limit);
  if (!targets.length || running) {
    return;
  }

  if (limit > 1 && !window.confirm(`지금 로그인된 네이버 계정에 메모 ${targets.length}개를 새로 만듭니다. 계속할까요?`)) {
    return;
  }

  running = true;
  stopRequested = false;
  fileInput.disabled = true;
  stopButton.classList.toggle("hidden", limit === 1);
  renderPreview();

  let created = 0;
  const retitled = [];
  const retitledNote = () => retitled.length
    ? `\n\n제목이 거부되어 바꿔 저장한 메모 ${retitled.length}개 (원래 제목은 본문 맨 위에 남김):\n${retitled.join("\n")}`
    : "";
  try {
    setStatus("네이버 메모 탭을 준비하는 중입니다...", "");
    const tabId = await getMemoTabId();
    await ensureContentScript(tabId);

    for (const memo of targets) {
      if (stopRequested) {
        break;
      }
      setStatus(`메모 만드는 중 ${created + 1}/${targets.length}\n${memo.title || firstLine(memo.content)}`, "");

      const naverMemo = MemoParser.buildNaverMemo(memo, keepMetaInput.checked);
      const title = naverMemo.title;
      const response = await sendTabMessage(tabId, {
        type: "IMPORT_NAVER_MEMO",
        memo: naverMemo,
        userId: userIdInput.value.trim()
      });

      if (!response || !response.ok) {
        throw new Error((response && response.error) || "메모를 만들지 못했습니다.");
      }

      markImported(memo, response.memoSeq);
      if (response.titleChanged) {
        retitled.push(`"${title || "(제목 없음)"}" → "${response.title}"`);
      }
      created += 1;
      renderPreview();
      await sleep(IMPORT_DELAY_MS);
    }

    const left = targets.length - created;
    if (limit === 1) {
      setStatus(`테스트 메모 1개를 만들었습니다.\n네이버 메모 탭에서 제목·본문이 제대로 들어갔는지 확인한 뒤 '모두 가져오기'를 누르세요.${retitledNote()}`, "ok");
    } else if (left) {
      setStatus(`메모 ${created}개를 만들고 멈췄습니다. 남은 ${left}개는 다시 '모두 가져오기'로 이어서 가져올 수 있습니다.${retitledNote()}`, "warn");
    } else {
      setStatus(`메모 ${created}개를 모두 만들었습니다.${retitledNote()}`, "ok");
    }
  } catch (error) {
    setStatus(`${created ? `메모 ${created}개를 만든 뒤 ` : ""}오류로 멈췄습니다.\n${error.message || String(error)}${retitledNote()}`, "error");
  } finally {
    running = false;
    fileInput.disabled = false;
    stopButton.classList.add("hidden");
    renderPreview();
  }
}

// ---- 이미 가져온 메모 기록 (이 브라우저에만 저장) ----

function importKey(memo) {
  const identity = memo.id
    ? `id:${memo.id}`
    : `hash:${hashString(`${memo.title}\n${memo.date}\n${memo.content}`)}`;
  return IMPORTED_KEY_PREFIX + identity;
}

function importedKeys() {
  try {
    return Object.keys(localStorage).filter((key) => key.startsWith(IMPORTED_KEY_PREFIX));
  } catch (_) {
    return [];
  }
}

function wasImported(memo) {
  try {
    return localStorage.getItem(importKey(memo)) !== null;
  } catch (_) {
    return false;
  }
}

function markImported(memo, memoSeq) {
  try {
    localStorage.setItem(importKey(memo), String(memoSeq || Date.now()));
  } catch (_) {
    // 기록하지 못해도 가져오기는 계속합니다.
  }
}

function hashString(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

// ---- 네이버 메모 탭 ----

async function getMemoTabId() {
  const tabs = await chromePromise((resolve) => {
    chrome.tabs.query({ url: "https://memo.naver.com/*" }, resolve);
  });
  if (tabs && tabs.length) {
    return tabs[0].id;
  }

  const tab = await chromePromise((resolve) => {
    chrome.tabs.create({ url: MEMO_URL, active: false }, resolve);
  });
  await waitForTabComplete(tab.id);
  return tab.id;
}

function waitForTabComplete(tabId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("네이버 메모 탭을 여는 데 시간이 너무 오래 걸립니다."));
    }, 30000);
    const listener = (updatedId, info) => {
      if (updatedId === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function ensureContentScript(tabId) {
  try {
    await sendTabMessage(tabId, { type: "PING" });
  } catch (_) {
    await chromePromise((resolve) => {
      chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }, resolve);
    });
    await sleep(150);
    await sendTabMessage(tabId, { type: "PING" });
  }
}

function sendTabMessage(tabId, message) {
  return chromePromise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, resolve);
  });
}

function chromePromise(start) {
  return new Promise((resolve, reject) => {
    start((value) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
      } else {
        resolve(value);
      }
    });
  });
}

// ---- 기타 ----

function firstLine(value) {
  return String(value || "").split("\n").map((line) => line.trim()).find(Boolean) || "";
}

function setStatus(message, className) {
  statusEl.textContent = message;
  statusEl.className = className ? `status ${className}` : "status";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
