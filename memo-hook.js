"use strict";

// memo.naver.com 페이지 쪽(MAIN world)에서 실행됩니다.
// 네이버 메모 웹이 받아오는 응답 중 메모 정보(memoSeq, createdTime, title 등)를 모아 두었다가
// 확장의 content.js가 요청하면 넘겨줍니다. 요청을 새로 보내거나 내용을 바꾸지 않습니다.
(() => {
  if (window.__naverMemoHookInstalled) {
    return;
  }
  window.__naverMemoHookInstalled = true;

  const SOURCE_HOOK = "naver-memo-hook";
  const SOURCE_EXPORTER = "naver-memo-exporter";
  const memos = new Map();

  function remember(value, depth) {
    if (!value || typeof value !== "object" || depth > 6) {
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        remember(item, depth + 1);
      }
      return;
    }

    if (value.memoSeq !== undefined && (value.createdTime !== undefined || value.registerDate !== undefined)) {
      const id = String(value.memoSeq);
      const previous = memos.get(id) || {};
      memos.set(id, {
        id,
        hasTitleField: previous.hasTitleField || Object.prototype.hasOwnProperty.call(value, "title"),
        title: typeof value.title === "string" ? value.title : previous.title || "",
        createdTime: Number(value.createdTime) || previous.createdTime || 0,
        lastModifiedTime: Number(value.lastModifiedTime) || previous.lastModifiedTime || 0,
        registerDate: value.registerDate || previous.registerDate || "",
        modifyDate: value.modifyDate || previous.modifyDate || "",
        folderId: value.folderId !== undefined ? value.folderId : previous.folderId
      });
    }

    for (const key of Object.keys(value)) {
      const child = value[key];
      if (child && typeof child === "object") {
        remember(child, depth + 1);
      }
    }
  }

  function inspectText(text) {
    if (typeof text !== "string" || text.length < 2 || text.indexOf("memoSeq") < 0) {
      return;
    }
    try {
      remember(JSON.parse(text), 0);
    } catch (_) {
      // JSON이 아니면 무시합니다.
    }
  }

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function (...args) {
      const promise = originalFetch.apply(this, args);
      promise
        .then((response) => {
          try {
            response.clone().text().then(inspectText, () => {});
          } catch (_) {
            // 읽을 수 없는 응답은 무시합니다.
          }
        })
        .catch(() => {});
      return promise;
    };
  }

  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", () => {
      try {
        if (!this.responseType || this.responseType === "text") {
          inspectText(this.responseText);
        } else if (this.responseType === "json") {
          remember(this.response, 0);
        }
      } catch (_) {
        // 읽을 수 없는 응답은 무시합니다.
      }
    });
    return originalSend.apply(this, args);
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || event.data.source !== SOURCE_EXPORTER) {
      return;
    }
    if (event.data.type === "GET_MEMO_META") {
      window.postMessage({
        source: SOURCE_HOOK,
        type: "MEMO_META",
        requestId: event.data.requestId,
        memos: Array.from(memos.values())
      }, location.origin);
    }
  });
})();
