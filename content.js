"use strict";

(() => {
  if (window.__naverArchiveExporterLoaded) {
    return;
  }
  window.__naverArchiveExporterLoaded = true;

  const MEMO_LIST_URL = "https://memo.naver.com/?viewType=LIST";
  const BLOG_ROOT_URL = "https://blog.naver.com/";

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type === "PING") {
      sendResponse({ ok: true, target: detectPageTarget() });
      return false;
    }

    if (message.type === "EXPORT_NAVER_MEMO") {
      exportNaverMemo(message.options || {})
        .then(sendResponse)
        .catch((error) => {
          sendResponse({ ok: false, error: error.message || String(error) });
        });
      return true;
    }

    if (message.type === "IMPORT_NAVER_MEMO") {
      importNaverMemo(message.memo || {}, message.userId || "")
        .then(sendResponse)
        .catch((error) => {
          sendResponse({ ok: false, error: error.message || String(error) });
        });
      return true;
    }

    if (message.type === "GET_NAVER_BLOG_CATEGORIES") {
      getNaverBlogCategories()
        .then(sendResponse)
        .catch((error) => {
          sendResponse({ ok: false, error: error.message || String(error) });
        });
      return true;
    }

    if (message.type !== "EXPORT_NAVER_DATA") {
      return false;
    }

    const options = message.options || {};
    const target = options.target || detectPageTarget();
    const exporter = target === "memo"
      ? exportNaverMemo
      : target === "blog"
        ? exportNaverBlog
        : null;

    if (!exporter) {
      sendResponse({ ok: false, error: "네이버 메모 또는 네이버 블로그 탭에서 실행해 주세요." });
      return false;
    }

    exporter(options)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({ ok: false, error: error.message || String(error) });
      });
    return true;
  });

  function detectPageTarget() {
    if (/^https:\/\/memo\.naver\.com\//i.test(location.href)) {
      return "memo";
    }
    if (/^https:\/\/(?:m\.)?blog\.naver\.com\//i.test(location.href)) {
      return "blog";
    }
    return "";
  }

  async function exportNaverMemo(options) {
    if (!/^https:\/\/memo\.naver\.com\//i.test(location.href)) {
      throw new Error("네이버 메모 목록 화면을 연 뒤 다시 실행해 주세요.");
    }

    await waitForMemoList();

    const delayMs = Number(options.delayMs) || 450;
    const maxScrolls = Number(options.maxScrolls) || 500;
    const refs = await collectMemoRefs(delayMs, maxScrolls);
    if (!refs.length) {
      throw new Error("목록에서 메모를 찾지 못했습니다.");
    }

    const memos = [];
    let exactDates = 0;
    for (let index = 0; index < refs.length; index += 1) {
      const ref = refs[index];
      sendProgress(index + 1, refs.length, `메모 ID ${ref.id} 여는 중`, "메모");
      await openMemo(ref, delayMs);
      const metaMap = await requestMemoMeta();
      const memo = extractCurrentMemo(ref, metaMap.get(String(ref.id)));
      if (memo.exactDate) {
        exactDates += 1;
      }
      memos.push(memo);
    }

    const exportMode = normalizeExportMode(options.exportMode);
    const fileName = normalizeDownloadFileName(options.fileName, "memo", exportMode);
    if (exportMode === "separate") {
      sendProgress(refs.length, refs.length, "ZIP 파일을 만드는 중입니다.", "메모");
      downloadZip(buildMemoZipEntries(memos), fileName);
    } else {
      const markdown = formatMemoMarkdown(memos);
      downloadText(markdown, fileName);
    }

    sendProgress(refs.length, refs.length, "다운로드를 시작했습니다.", "메모");
    const dateNote = exactDates === memos.length
      ? ""
      : exactDates
        ? `\n생성일시를 ${exactDates}/${memos.length}개만 확인했습니다. 나머지는 화면에 보이는 날짜로 저장했습니다.`
        : "\n생성일시를 읽지 못해 화면에 보이는 날짜로 저장했습니다. 네이버 메모 탭을 새로고침한 뒤 다시 내보내 보세요.";
    return { ok: true, count: memos.length, fileName: fileName + dateNote, label: "메모" };
  }

  // memo-hook.js(페이지 쪽)가 모아 둔 메모 정보(생성일시, 제목 등)를 받아옵니다.
  let memoMetaRequestId = 0;
  function requestMemoMeta(timeoutMs = 800) {
    const requestId = `meta-${Date.now()}-${memoMetaRequestId += 1}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        window.removeEventListener("message", listener);
        resolve(new Map());
      }, timeoutMs);
      const listener = (event) => {
        const data = event.data;
        if (event.source !== window || !data || data.source !== "naver-memo-hook"
          || data.type !== "MEMO_META" || data.requestId !== requestId) {
          return;
        }
        clearTimeout(timer);
        window.removeEventListener("message", listener);
        resolve(new Map((data.memos || []).map((meta) => [String(meta.id), meta])));
      };
      window.addEventListener("message", listener);
      window.postMessage({ source: "naver-memo-exporter", type: "GET_MEMO_META", requestId }, location.origin);
    });
  }

  function formatMemoTime(ms) {
    const date = new Date(Number(ms));
    if (!ms || Number.isNaN(date.getTime())) {
      return "";
    }
    const pad = (value) => String(value).padStart(2, "0");
    const weekday = ["일", "월", "화", "수", "목", "금", "토"][date.getDay()];
    const hour = date.getHours();
    const meridiem = hour < 12 ? "오전" : "오후";
    const hour12 = hour % 12 === 0 ? 12 : hour % 12;
    return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}.(${weekday}) ${meridiem} ${pad(hour12)}:${pad(date.getMinutes())}`;
  }

  // 네이버 메모 웹이 새 메모를 저장할 때 쓰는 요청과 같은 형식으로 메모 하나를 만듭니다.
  // memo.naver.com 페이지 안에서 보내므로 로그인 쿠키가 그대로 쓰입니다.
  // 제목이 거부되면(너무 길거나, 이모지처럼 받지 않는 글자가 있거나, 비어 있을 때)
  // 더 안전한 제목으로 다시 시도하고, 원래 제목은 본문 맨 위 줄로 옮겨 글이 빠지지 않게 합니다.
  async function importNaverMemo(memo, userId) {
    if (!/^https:\/\/memo\.naver\.com\//i.test(location.href)) {
      throw new Error("네이버 메모 탭에서만 가져올 수 있습니다.");
    }

    const originalTitle = String(memo.title || "");
    const content = String(memo.content || "");
    const candidates = memoTitleCandidates(originalTitle, content);
    let lastDetail = "";

    for (const title of candidates) {
      const text = title === originalTitle || !originalTitle.trim()
        ? content
        : (content ? `${originalTitle}\n${content}` : originalTitle);
      // 네이버 메모 본문은 줄마다 <div>로 감싼 HTML(editorVersion 2)로 저장됩니다.
      // 혹시 거부되면 예전 형식(일반 텍스트, editorVersion 1)으로 한 번 더 시도합니다.
      let result = await postNaverMemo(title, memoTextToHtml(text), userId, "2");
      if (!result.ok && !result.invalidTitle) {
        result = await postNaverMemo(title, text, userId, "1");
      }
      if (result.ok) {
        return {
          ok: true,
          memoSeq: result.memoSeq,
          titleChanged: title !== originalTitle,
          title
        };
      }
      lastDetail = result.detail;
      if (!result.invalidTitle) {
        break;
      }
    }

    const titleProblem = /제목/.test(lastDetail);
    const hint = titleProblem
      ? `제목을 바꿔 여러 번 시도했지만 저장되지 않았습니다. 원래 제목: "${originalTitle}"`
      : userId
        ? "네이버 메모에 로그인되어 있는지 확인해 주세요."
        : "네이버에 로그인되어 있는지 확인하고, 그래도 안 되면 네이버 아이디를 입력한 뒤 다시 시도해 주세요.";
    throw new Error(`메모 저장 실패: ${lastDetail}\n${hint}`);
  }

  function memoTitleCandidates(title, content) {
    const strip = (value) => String(value || "")
      .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\ufeff]/g, " ")
      .replace(/[\ud800-\udfff]/g, "")
      .replace(/[\ufe0f\u20e3]/g, "")
      .replace(/[<>]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const cut = (value, length) => Array.from(value).slice(0, length).join("").trim();
    const firstLine = content.split("\n")
      .map(strip)
      .find(Boolean) || "";
    const safe = strip(title);
    const plain = safe
      .replace(/[^\p{L}\p{N}\s.,!?()[\]{}'"~@#$%&*+=:;/_-]/gu, "")
      .replace(/\s+/g, " ")
      .trim();

    const list = [
      title,
      safe,
      cut(safe, 50),
      plain,
      cut(plain, 50),
      cut(plain, 20),
      cut(firstLine, 50),
      cut(firstLine, 20),
      "제목 없음"
    ];
    // 빈 제목은 처음부터 빈 제목으로 보낸 경우(제목 없는 메모)에만 시도합니다.
    return list.filter((value, index) => (value || index === 0) && list.indexOf(value) === index);
  }

  // 줄마다 <div>…</div>, 빈 줄은 <div><br></div> (네이버 메모 웹 에디터와 같은 형식)
  function memoTextToHtml(text) {
    const escape = (value) => value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/ {2}/g, " &nbsp;")
      .replace(/^ /, "&nbsp;")
      .replace(/\t/g, "&nbsp;&nbsp;&nbsp;&nbsp;");
    const lines = String(text || "").split("\n");
    if (lines.length === 1 && !lines[0]) {
      return "";
    }
    return lines.map((line) => (line ? `<div>${escape(line)}</div>` : "<div><br></div>")).join("");
  }

  async function postNaverMemo(title, content, userId, editorVersion = "2") {
    const body = new URLSearchParams({
      title,
      memoContent: content,
      important: "false",
      colorId: "0",
      folderId: "0",
      editorVersion
    });
    const headers = {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"
    };
    if (userId) {
      headers.userid = userId;
    }

    let response;
    try {
      response = await fetch("https://memo.naver.com/memo/writeMemo", {
        method: "POST",
        credentials: "include",
        headers,
        body
      });
    } catch (error) {
      throw new Error(`네이버 메모 서버에 연결하지 못했습니다. (${error.message || error})`);
    }

    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (_) {
      // 로그인 페이지 HTML 등이 돌아온 경우
    }

    if (response.ok && json && json.code === "SUCCESS") {
      return { ok: true, memoSeq: json.data && json.data.memoSeq };
    }

    const detail = json && (json.message || json.code)
      ? `${json.code || ""} ${json.message || ""}`.trim()
      : `HTTP ${response.status}`;
    return {
      ok: false,
      detail,
      invalidTitle: !!(json && /제목/.test(String(json.message || "")))
    };
  }

  async function waitForMemoList() {
    await waitFor(() => {
      if (/nid\.naver\.com/i.test(location.href)) {
        throw new Error("네이버 로그인이 필요합니다. 로그인 후 네이버 메모 목록에서 다시 실행해 주세요.");
      }
      return !!document.querySelector("ul.memo_list_view");
    }, 30000, 300, "네이버 메모 목록을 기다리는 중 시간이 초과되었습니다.");
  }

  async function collectMemoRefs(delayMs, maxScrolls) {
    const scrollEl = findMemoScrollElement();
    const seen = new Map();

    const collectVisible = () => {
      for (const item of document.querySelectorAll("ul.memo_list_view > li.paper_item[data-id]")) {
        const id = item.getAttribute("data-id");
        if (!id || seen.has(id)) {
          continue;
        }

        seen.set(id, {
          id,
          top: itemTop(item),
          title: cleanText(item.querySelector(".paper_title")),
          category: cleanText(item.querySelector(".paper_footer .folder_name")),
          date: cleanDate(cleanText(item.querySelector(".paper_footer .date")))
        });
      }
    };

    scrollEl.scrollTop = 0;
    emitScroll(scrollEl);
    await sleep(delayMs);
    collectVisible();

    let stableSteps = 0;
    let previousTop = -1;
    let previousSize = seen.size;

    for (let step = 0; step < maxScrolls; step += 1) {
      const beforeTop = scrollEl.scrollTop;
      const delta = Math.max(90, Math.floor(scrollEl.clientHeight * 0.85));
      scrollEl.scrollTop = beforeTop + delta;
      emitScroll(scrollEl);
      await sleep(delayMs);
      collectVisible();

      const nearBottom = scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 4;
      const didNotMove = scrollEl.scrollTop === beforeTop || scrollEl.scrollTop === previousTop;
      const didNotGrow = seen.size === previousSize;

      if ((nearBottom || didNotMove) && didNotGrow) {
        stableSteps += 1;
      } else {
        stableSteps = 0;
      }

      previousTop = scrollEl.scrollTop;
      previousSize = seen.size;

      if (stableSteps >= 2) {
        break;
      }
    }

    scrollEl.scrollTop = 0;
    emitScroll(scrollEl);
    await sleep(Math.min(delayMs, 300));

    return Array.from(seen.values()).sort((a, b) => a.top - b.top);
  }

  async function openMemo(ref, delayMs) {
    const scrollEl = findMemoScrollElement();
    let item = findMemoItem(ref.id);

    if (!item) {
      scrollEl.scrollTop = Math.max(0, ref.top - 30);
      emitScroll(scrollEl);
      await sleep(delayMs);
      item = findMemoItem(ref.id);
    }

    if (!item) {
      item = await scanForMemoItem(scrollEl, ref.id, delayMs);
    }

    if (!item) {
      throw new Error(`목록에서 메모 ID ${ref.id}를 찾지 못했습니다.`);
    }

    const button = item.querySelector(".paper_link") || item.querySelector("button") || item;
    button.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true }));
    button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    button.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    button.click();

    await waitFor(() => {
      const selected = document.querySelector("ul.memo_list_view > li.paper_item.selected");
      const selectedId = selected ? selected.getAttribute("data-id") : "";
      const content = document.querySelector(".memo_detail_area .workseditor-content");
      const params = new URLSearchParams(location.search);
      return !!content && (selectedId === ref.id || params.get("memoId") === ref.id);
    }, 15000, 200, "메모 본문을 여는 중 시간이 초과되었습니다.");

    await sleep(delayMs);
  }

  async function scanForMemoItem(scrollEl, id, delayMs) {
    const maxTop = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
    const step = Math.max(90, Math.floor(scrollEl.clientHeight * 0.75));

    for (let top = 0; top <= maxTop + step; top += step) {
      scrollEl.scrollTop = Math.min(top, maxTop);
      emitScroll(scrollEl);
      await sleep(delayMs);

      const item = findMemoItem(id);
      if (item) {
        return item;
      }
    }
    return null;
  }

  function extractCurrentMemo(ref, meta) {
    const detail = document.querySelector(".memo_detail_area") || document;
    const selected = findMemoItem(ref.id);
    const contentEl = detail.querySelector(".workseditor-content");

    // 제목 없는 메모는 네이버에도 제목이 ""로 저장되어 있으므로 본문 첫 줄로 채우지 않습니다.
    // (제목 칸을 못 찾는 화면에서만 목록에 보이는 제목을 씁니다.)
    // 네이버 메모 데이터에 제목이 있으면 그것을 쓰고, 없으면 화면의 제목 칸을 봅니다.
    const titleEl = detail.querySelector(".edit_title");
    const domTitle = titleEl ? readMemoTitle(titleEl) : ref.title;
    const title = meta && meta.title ? oneLine(meta.title) : domTitle;
    const category = cleanText(detail.querySelector(".info_area .folder_name .text"))
      || cleanText(detail.querySelector(".info_area .folder_name"))
      || cleanText(detail.querySelector(".folder_name .text"))
      || ref.category;
    // 화면에 보이는 시각은 마지막 수정 시각이므로, 메모 데이터의 생성일시(createdTime)를 우선 씁니다.
    const createdText = meta ? formatMemoTime(meta.createdTime) : "";
    const modifiedText = meta ? formatMemoTime(meta.lastModifiedTime) : "";
    const screenDate = cleanDate(
      cleanText(detail.querySelector(".info_area .time_stamp"))
      || cleanText(detail.querySelector(".time_stamp"))
      || (selected ? cleanText(selected.querySelector(".paper_footer .date")) : "")
      || ref.date
    );
    const content = contentToMarkdown(contentEl);

    return {
      id: ref.id,
      url: `${MEMO_LIST_URL}&memoId=${encodeURIComponent(ref.id)}`,
      date: createdText || screenDate,
      modified: createdText ? (modifiedText !== createdText ? modifiedText : "") : "",
      exactDate: !!createdText,
      title: title || "",
      category: category || "알 수 없음",
      content
    };
  }

  function readMemoTitle(el) {
    const field = el.matches("input, textarea") ? el : el.querySelector("input, textarea");
    if (field) {
      return oneLine(field.value);
    }
    return oneLine(cleanText(el));
  }

  function findMemoScrollElement() {
    const list = document.querySelector("ul.memo_list_view");
    let el = list ? list.parentElement : null;
    while (el && el !== document.body) {
      const style = getComputedStyle(el);
      if (el.scrollHeight > el.clientHeight + 2 && /(auto|scroll)/.test(style.overflowY)) {
        return el;
      }
      el = el.parentElement;
    }
    return document.querySelector(".memo_list_wrap") || document.scrollingElement || document.documentElement;
  }

  function findMemoItem(id) {
    return Array.from(document.querySelectorAll("ul.memo_list_view > li.paper_item[data-id]"))
      .find((item) => item.getAttribute("data-id") === id) || null;
  }

  function itemTop(item) {
    const styleTop = parseFloat(item.style.top || "");
    if (Number.isFinite(styleTop)) {
      return styleTop;
    }
    return item.offsetTop || 0;
  }

  async function exportNaverBlog(options) {
    if (!/^https:\/\/(?:m\.)?blog\.naver\.com\//i.test(location.href)) {
      throw new Error("네이버 블로그 탭을 연 뒤 다시 실행해 주세요.");
    }

    const blogId = getCurrentBlogId();
    if (!blogId) {
      throw new Error("현재 페이지에서 블로그 ID를 찾지 못했습니다.");
    }

    const visibility = options.blogVisibility === "all" ? "all" : "public";
    const delayMs = Number(options.delayMs) || 250;
    const maxPages = Number(options.maxPages) || 1000;
    const categories = normalizeBlogCategoryTargets(options.blogCategories);
    const posts = await collectBlogPosts(blogId, visibility, maxPages, delayMs, categories);
    if (!posts.length) {
      throw new Error("내보낼 블로그 글을 찾지 못했습니다. 비공개 글은 블로그 소유자로 로그인해야 보입니다.");
    }

    const exportMode = normalizeExportMode(options.exportMode);
    const fileName = normalizeDownloadFileName(options.fileName, "blog", exportMode);
    const context = { blogId, visibility, categories };
    if (exportMode === "separate") {
      sendProgress(posts.length, posts.length, "ZIP 파일을 만드는 중입니다.", "블로그 글", "post");
      downloadZip(buildBlogZipEntries(posts), fileName);
    } else {
      const markdown = formatBlogMarkdown(posts, context);
      downloadText(markdown, fileName);
    }

    sendProgress(posts.length, posts.length, "다운로드를 시작했습니다.", "블로그 글", "post");
    return { ok: true, count: posts.length, fileName, label: "블로그 글" };
  }

  async function getNaverBlogCategories() {
    if (!/^https:\/\/(?:m\.)?blog\.naver\.com\//i.test(location.href)) {
      throw new Error("네이버 블로그 탭에서 카테고리를 불러올 수 있습니다.");
    }

    const blogId = getCurrentBlogId();
    if (!blogId) {
      throw new Error("현재 페이지에서 블로그 ID를 찾지 못했습니다.");
    }

    const docs = collectCurrentBlogDocuments();
    const fetchedDocs = await Promise.all([
      fetchBlogDocumentOrNull(buildBlogHomeUrl(blogId)),
      fetchBlogDocumentOrNull(buildBlogPostListUrl(blogId, "0", 1))
    ]);
    fetchedDocs.forEach((doc) => appendBlogDocument(docs, doc));

    return {
      ok: true,
      blogId,
      categories: extractBlogCategoriesFromDocuments(docs, blogId)
    };
  }

  async function collectBlogPosts(blogId, visibility, maxPages, delayMs, categories) {
    const targets = normalizeBlogCategoryTargets(categories);
    const seen = new Map();
    let scannedPostCount = 0;
    let expectedPostCount = sumCategoryCounts(targets);

    for (const target of targets) {
      const seenPageSignatures = new Set();
      let page = 1;
      let highestKnownPage = 1;
      let emptyPages = 0;

      while (page <= maxPages) {
        sendProgress(scannedPostCount, expectedPostCount || "?", `${target.name} 확인 중`, "블로그 글", "post");

        const url = buildBlogPostListUrl(blogId, target.categoryNo, page);
        const doc = await fetchBlogDocument(url);
        if (!target.count) {
          const count = getBlogPostCountFromDocument(doc);
          if (count > 0) {
            target.count = count;
            expectedPostCount = sumCategoryCounts(targets);
          }
        }

        const pagePosts = extractBlogPostsFromDocument(doc, blogId);
        const pageInfo = getBlogPaginationInfo(doc);
        const pageSignature = pagePosts.map((post) => post.logNo).join(",");

        if (pageSignature && seenPageSignatures.has(pageSignature)) {
          break;
        }
        if (pageSignature) {
          seenPageSignatures.add(pageSignature);
        }

        highestKnownPage = Math.max(highestKnownPage, pageInfo.maxPage, page);
        scannedPostCount += pagePosts.length;

        for (const post of pagePosts) {
          if (visibility === "public" && post.visibility !== "public") {
            continue;
          }
          if (!seen.has(post.logNo)) {
            seen.set(post.logNo, post);
          }
        }

        sendProgress(scannedPostCount, expectedPostCount || "?", `${target.name} 확인 중`, "블로그 글", "post");

        const hasMorePages = pageInfo.hasNext || page < highestKnownPage;
        if (!pagePosts.length) {
          emptyPages += 1;
        } else {
          emptyPages = 0;
        }

        if (emptyPages >= 2) {
          break;
        }
        if (!hasMorePages && !pagePosts.length) {
          break;
        }

        page += 1;
        await sleep(delayMs);
      }
    }

    return Array.from(seen.values());
  }

  function getCurrentBlogId() {
    const fromGlobal = safeValue(() => window.blogId);
    if (fromGlobal) {
      return String(fromGlobal);
    }

    const html = document.documentElement ? document.documentElement.innerHTML : "";
    const fromScript = html.match(/\bblogId\s*=\s*['"]([^'"]+)['"]/);
    if (fromScript && fromScript[1]) {
      return fromScript[1];
    }

    const frame = document.querySelector("iframe#mainFrame");
    const frameSrc = frame ? frame.getAttribute("src") : "";
    const fromFrame = parseBlogIdFromUrl(frameSrc || "");
    if (fromFrame) {
      return fromFrame;
    }

    return parseBlogIdFromUrl(location.href);
  }

  function parseBlogIdFromUrl(value) {
    if (!value) {
      return "";
    }

    let url;
    try {
      url = new URL(value, location.href);
    } catch (_) {
      return "";
    }

    const fromParam = url.searchParams.get("blogId");
    if (fromParam) {
      return fromParam;
    }

    const match = url.pathname.match(/^\/([^/?#]+)(?:\/\d+)?\/?$/);
    if (!match) {
      return "";
    }

    const reserved = new Set([
      "PostList.naver",
      "PostView.naver",
      "PostPreview.naver",
      "category",
      "section"
    ]);
    const candidate = decodeURIComponent(match[1]);
    return reserved.has(candidate) ? "" : candidate;
  }

  function buildBlogPostListUrl(blogId, categoryNo, page) {
    const url = new URL("/PostList.naver", BLOG_ROOT_URL);
    url.searchParams.set("from", "postList");
    url.searchParams.set("blogId", blogId);
    url.searchParams.set("categoryNo", String(categoryNo || "0"));
    if (page > 1) {
      url.searchParams.set("currentPage", String(page));
    }
    return url.toString();
  }

  function buildBlogHomeUrl(blogId) {
    return `${BLOG_ROOT_URL}${encodeURIComponent(blogId)}`;
  }

  function normalizeBlogCategoryTargets(categories) {
    const source = Array.isArray(categories) ? categories : [];
    const seen = new Set();
    const targets = [];
    const specific = source.filter((category) => String(category.categoryNo || "") !== "0");
    const selected = specific.length ? specific : source.filter((category) => String(category.categoryNo || "") === "0");

    const add = (category) => {
      const categoryNo = String(category.categoryNo || "").trim();
      const name = oneLine(category.name) || (categoryNo === "0" ? "전체 카테고리" : `카테고리 ${categoryNo}`);
      if (!categoryNo || seen.has(categoryNo)) {
        return;
      }
      seen.add(categoryNo);
      targets.push({
        categoryNo,
        name,
        count: Number(category.count || 0)
      });
    };

    selected.forEach(add);
    if (!targets.length) {
      add({ categoryNo: "0", name: "전체 카테고리", count: 0 });
    }
    return targets;
  }

  function sumCategoryCounts(categories) {
    return categories.reduce((total, category) => total + (Number(category.count || 0) || 0), 0);
  }

  function collectCurrentBlogDocuments() {
    const docs = [];
    appendBlogDocument(docs, document);

    for (const frame of document.querySelectorAll("iframe")) {
      try {
        appendBlogDocument(docs, frame.contentDocument);
      } catch (_) {
        // Cross-origin frames are not needed for Naver blog category parsing.
      }
    }

    return docs;
  }

  function appendBlogDocument(docs, doc) {
    if (doc && doc.documentElement && !docs.includes(doc)) {
      docs.push(doc);
    }
  }

  function extractBlogCategoriesFromDocument(doc, blogId) {
    return extractBlogCategoriesFromDocuments([doc], blogId);
  }

  function extractBlogCategoriesFromDocuments(docs, blogId) {
    const categories = new Map();
    const allCount = docs.reduce((max, doc) => Math.max(
      max,
      getBlogPostCountFromDocument(doc),
      getBlogCategoryAllCountFromDocument(doc)
    ), 0);

    const add = (category) => {
      const categoryNo = String(category.categoryNo || "").trim();
      const name = oneLine(category.name);
      if (!categoryNo || !name) {
        return;
      }

      const previous = categories.get(categoryNo);
      if (previous) {
        const count = Number(category.count || 0) || 0;
        previous.count = Math.max(Number(previous.count || 0) || 0, count);
        if (
          categoryNo !== "0"
          && name.includes(" / ")
          && !String(previous.name || "").includes(" / ")
        ) {
          previous.name = name;
        }
        return;
      }

      categories.set(categoryNo, {
        categoryNo,
        name,
        count: Number(category.count || 0) || 0
      });
    };

    add({ categoryNo: "0", name: "전체 카테고리", count: allCount });

    for (const doc of docs) {
      for (const link of doc.querySelectorAll("a[href*='categoryNo=']")) {
        const href = link.getAttribute("href") || "";
        const className = String(link.className || "");
        if (/[?&]currentPage=\d+/i.test(href) || /\b(page|next|prev)\b/i.test(className)) {
          continue;
        }

        let url;
        try {
          url = new URL(href, BLOG_ROOT_URL);
        } catch (_) {
          continue;
        }

        if (!isBlogCategoryLink(link, url)) {
          continue;
        }

        const linkBlogId = url.searchParams.get("blogId");
        if (linkBlogId && linkBlogId !== blogId) {
          continue;
        }

        const categoryNo = String(url.searchParams.get("categoryNo") || "").trim();
        const parsed = parseCategoryOptionLabel(cleanText(link));
        const count = parsed.count || getCategoryCountNearLink(link);
        if (categoryNo === "0") {
          add({ categoryNo, name: "전체 카테고리", count });
          continue;
        }
        if (!categoryNo || !parsed.name || /^\d+$/.test(parsed.name) || /페이지|목록열기|URL 복사/.test(parsed.name)) {
          continue;
        }

        add({
          categoryNo,
          name: getBlogCategoryDisplayName(link, parsed.name),
          count
        });
      }
    }

    return Array.from(categories.values());
  }

  function isBlogCategoryLink(link, url) {
    const href = link.getAttribute("href") || "";
    const id = link.getAttribute("id") || "";
    return /PostList\.naver/i.test(href)
      || /\/PostList\.naver$/i.test(url.pathname)
      || /^category\d+$/i.test(id)
      || !!link.closest("#blog-category, #category-list, .wrap_blog2_categorylist");
  }

  function getBlogCategoryDisplayName(link, name) {
    const parentName = getBlogParentCategoryName(link);
    return parentName && parentName !== name ? `${parentName} / ${name}` : name;
  }

  function getBlogParentCategoryName(link) {
    const item = link.closest("li");
    if (!item || !/\bdepth2\b/.test(String(item.className || ""))) {
      return "";
    }

    const parentMatch = String(item.className || "").match(/\bparentcategoryno_(\d+)\b/);
    if (!parentMatch) {
      return "";
    }

    const root = item.parentElement || link.ownerDocument;
    const parentLink = root.querySelector(`#category${parentMatch[1]}`);
    if (!parentLink || parentLink === link) {
      return "";
    }

    return parseCategoryOptionLabel(cleanText(parentLink)).name;
  }

  function getBlogCategoryAllCountFromDocument(doc) {
    const links = Array.from(doc.querySelectorAll("a[href*='categoryNo=0'], a#category0"));
    for (const link of links) {
      let url;
      try {
        url = new URL(link.getAttribute("href") || location.href, BLOG_ROOT_URL);
      } catch (_) {
        continue;
      }

      if (isBlogCategoryLink(link, url)) {
        const count = getCategoryCountNearLink(link);
        if (count > 0) {
          return count;
        }
      }
    }
    return 0;
  }

  function getCategoryCountNearLink(link) {
    const values = [];
    const addText = (el) => {
      const value = cleanText(el);
      if (value) {
        values.push(value);
      }
    };

    addText(link);
    addText(link.nextElementSibling);
    addText(link.previousElementSibling);

    const item = link.closest("li") || link.parentElement;
    if (item) {
      addText(item.querySelector(".num, .count, .category_count"));
      addText(item);
    }

    for (const value of values) {
      const match = value.match(/[\(\[]\s*([\d,]+)\s*[\)\]]/) || value.match(/([\d,]+)\s*개의\s*글/);
      if (match) {
        return Number(match[1].replace(/,/g, "")) || 0;
      }
    }

    return 0;
  }

  function parseCategoryOptionLabel(value) {
    const label = oneLine(value).replace(/\s+/g, " ");
    const match = label.match(/^(.*?)\s*\(([\d,]+)\)\s*$/);
    if (!match) {
      return { name: label, count: 0 };
    }

    return {
      name: oneLine(match[1]),
      count: Number(match[2].replace(/,/g, "")) || 0
    };
  }

  function getBlogPostCountFromDocument(doc) {
    const candidates = [
      cleanText(doc.querySelector("#category-name")),
      cleanText(doc.querySelector(".post_top_title_aggregate_expose")),
      cleanText(doc.querySelector(".wrap_blog2_categorylist"))
    ];

    for (const candidate of candidates) {
      const match = candidate.match(/([\d,]+)\s*개의\s*글/);
      if (match) {
        return Number(match[1].replace(/,/g, "")) || 0;
      }
    }

    return 0;
  }

  async function fetchBlogDocument(url) {
    let response;
    try {
      response = await fetch(url, { credentials: "include" });
    } catch (_) {
      throw new Error("블로그 목록을 읽지 못했습니다. PC용 네이버 블로그 주소에서 다시 시도해 주세요.");
    }

    if (!response.ok) {
      throw new Error(`블로그 목록을 읽지 못했습니다. (${response.status})`);
    }

    const html = await response.text();
    return new DOMParser().parseFromString(html, "text/html");
  }

  async function fetchBlogDocumentOrNull(url) {
    try {
      return await fetchBlogDocument(url);
    } catch (_) {
      return null;
    }
  }

  function getBlogPaginationInfo(doc) {
    let maxPage = 1;
    let hasNext = false;
    const roots = Array.from(doc.querySelectorAll(".pagination_area, .paginate, .blog2_paginate, .post_paginate"));
    const links = roots.length
      ? roots.flatMap((root) => Array.from(root.querySelectorAll("a[href*='currentPage=']")))
      : Array.from(doc.querySelectorAll("a.page[href*='currentPage='], a.next[href*='currentPage='], a.prev[href*='currentPage=']"));

    for (const link of links) {
      const pageFromHref = pageNumberFromHref(link.getAttribute("href") || "");
      const pageFromText = /\bpage\b/.test(String(link.className || ""))
        ? Number(cleanText(link).replace(/[^\d]/g, ""))
        : 0;
      const page = [pageFromHref, pageFromText]
        .filter((value) => Number.isFinite(value) && value > 0)
        .reduce((max, value) => Math.max(max, value), 0);

      if (page > maxPage) {
        maxPage = page;
      }

      const className = String(link.className || "");
      if (/\bnext\b/.test(className) && page > 0) {
        hasNext = true;
      }
    }

    return { maxPage, hasNext };
  }

  function pageNumberFromHref(href) {
    if (!href) {
      return 0;
    }
    try {
      const url = new URL(href, BLOG_ROOT_URL);
      return Number(url.searchParams.get("currentPage") || "");
    } catch (_) {
      const match = href.match(/[?&]currentPage=(\d+)/);
      return match ? Number(match[1]) : 0;
    }
  }

  function extractBlogPostsFromDocument(doc, blogId) {
    return Array.from(doc.querySelectorAll("[id^='post-view']"))
      .filter((el) => /^post-view\d+$/.test(el.id || ""))
      .map((el) => extractBlogPost(el, blogId))
      .filter((post) => post.logNo && (post.title || post.content));
  }

  function extractBlogPost(postEl, blogId) {
    const logNo = (postEl.id || "").replace(/^post-view/, "");
    const title = findBlogTitle(postEl);
    const category = cleanText(postEl.querySelector(".blog2_series a"))
      || cleanText(postEl.querySelector(".post_category"))
      || cleanText(postEl.querySelector(".category"));
    const date = cleanDate(
      cleanText(postEl.querySelector(".se_publishDate"))
      || cleanText(postEl.querySelector(".date"))
      || cleanText(postEl.querySelector(".post-date"))
    );
    const contentEl = findBlogContentElement(postEl);
    const content = contentToMarkdown(contentEl, { omitImages: true });
    const visibility = detectBlogVisibility(postEl);

    return {
      logNo,
      url: findBlogPostUrl(postEl, blogId, logNo),
      date,
      title: title || "제목 없음",
      category: category || "전체",
      visibility,
      content
    };
  }

  function findBlogTitle(postEl) {
    const selectors = [
      ".se-documentTitle .se-title-text",
      ".se-documentTitle .pcol1",
      ".htitle .pcol1",
      ".post_title",
      ".post-title",
      "h3"
    ];

    for (const selector of selectors) {
      const value = cleanText(postEl.querySelector(selector));
      if (value) {
        return value;
      }
    }
    return "";
  }

  function findBlogContentElement(postEl) {
    const containers = Array.from(postEl.querySelectorAll(".se-viewer > .se-main-container, .se-main-container"));
    const content = containers.find((el) => !el.closest(".se-documentTitle"));
    if (content) {
      return content;
    }

    return postEl.querySelector(".post_ct, .post_content, .post-view, .view, .post_body") || postEl;
  }

  function findBlogPostUrl(postEl, blogId, logNo) {
    const copyTarget = postEl.querySelector(".copyTargetUrl");
    const fromValue = copyTarget ? copyTarget.value || copyTarget.getAttribute("value") : "";
    if (fromValue) {
      return fromValue;
    }

    const urlButton = postEl.querySelector("[title^='http'][title*='blog.naver.com']");
    const fromTitle = urlButton ? urlButton.getAttribute("title") : "";
    if (fromTitle) {
      return fromTitle;
    }

    return `${BLOG_ROOT_URL}${encodeURIComponent(blogId)}/${encodeURIComponent(logNo)}`;
  }

  function detectBlogVisibility(postEl) {
    const scopes = [
      ".se-documentTitle",
      ".blog2_post_function",
      ".htitle",
      ".post_title",
      ".post_info",
      ".post-btn",
      ".post-back .pcol1"
    ]
      .map((selector) => postEl.querySelector(selector))
      .filter(Boolean);

    const values = scopes.map((scope) => cleanMultiline(scope.innerText || scope.textContent || ""));
    for (const scope of scopes) {
      for (const el of scope.querySelectorAll("[class], [alt], [title], [aria-label]")) {
        values.push(String(el.className || ""));
        values.push(el.getAttribute("alt") || "");
        values.push(el.getAttribute("title") || "");
        values.push(el.getAttribute("aria-label") || "");
      }
    }

    if (hasPrivateMarker(values.join(" "))) {
      return "private";
    }

    if (hasReadableBlogContent(postEl)) {
      return "public";
    }

    const fallbackValues = [
      cleanMultiline(postEl.innerText || postEl.textContent || "")
    ];
    for (const el of postEl.querySelectorAll("[alt], [title], [aria-label]")) {
      fallbackValues.push(el.getAttribute("alt") || "");
      fallbackValues.push(el.getAttribute("title") || "");
      fallbackValues.push(el.getAttribute("aria-label") || "");
    }

    return hasPrivateMarker(fallbackValues.join(" "))
      ? "private"
      : "public";
  }

  function hasReadableBlogContent(postEl) {
    return !!postEl.querySelector(
      ".se-viewer > .se-main-container, .se-main-container, .post_ct, .post_content, .post_body"
    );
  }

  function hasPrivateMarker(value) {
    const text = value || "";
    return /비공개|이웃공개|서로이웃|보호글|제한\s*공개/i.test(text)
      || /(^|[\s_-])(secret|private|lock)([\s_-]|$)/i.test(text);
  }

  function contentToMarkdown(contentEl, options = {}) {
    if (!contentEl) {
      return "";
    }

    const markdown = Array.from(contentEl.childNodes)
      .map((node) => nodeToMarkdown(node, options))
      .join("")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    return markdown || cleanMultiline(contentEl.innerText || contentEl.textContent || "");
  }

  function nodeToMarkdown(node, options = {}) {
    if (node.nodeType === Node.TEXT_NODE) {
      return (node.nodeValue || "").replace(/\u00a0/g, " ");
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return "";
    }

    const el = node;
    const tag = el.tagName.toLowerCase();
    if (tag === "script" || tag === "style" || tag === "noscript") {
      return "";
    }

    const inner = Array.from(el.childNodes).map((child) => nodeToMarkdown(child, options)).join("");

    if (tag === "br") {
      return "\n";
    }
    if (tag === "img") {
      if (options.omitImages) {
        return "";
      }
      const src = el.currentSrc || el.src || el.getAttribute("src") || "";
      const alt = el.getAttribute("alt") || "이미지";
      return src ? `![${escapeBracketText(alt)}](${src})` : "";
    }
    if (tag === "iframe" || tag === "video") {
      const src = el.src || el.getAttribute("src") || "";
      return src ? `\n${src}\n` : inner;
    }
    if (tag === "a") {
      const href = el.href || el.getAttribute("href") || "";
      const label = normalizeInline(inner);
      if (options.omitImages && !label && isImageOnlyLink(el, href)) {
        return "";
      }
      return href ? `[${escapeBracketText(label || href)}](${href})` : label;
    }
    if (tag === "strong" || tag === "b") {
      const value = normalizeInline(inner);
      return value ? `**${value}**` : "";
    }
    if (tag === "em" || tag === "i") {
      const value = normalizeInline(inner);
      return value ? `*${value}*` : "";
    }
    if (tag === "input" && el.type === "checkbox") {
      return el.checked ? "[x] " : "[ ] ";
    }
    if (tag === "li") {
      return `- ${inner.trim().replace(/\n/g, "\n  ")}\n`;
    }
    if (tag === "ul" || tag === "ol") {
      return `\n${inner.trim()}\n`;
    }
    if (tag === "tr") {
      const cells = Array.from(el.children)
        .filter((child) => /^(td|th)$/i.test(child.tagName))
        .map((cell) => normalizeInline(Array.from(cell.childNodes).map((child) => nodeToMarkdown(child, options)).join("")));
      return cells.length ? `| ${cells.join(" | ")} |\n` : inner;
    }
    if (tag === "table") {
      return `\n${inner.trim()}\n`;
    }
    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag.slice(1));
      const value = normalizeInline(inner);
      return value ? `${"#".repeat(level)} ${value}\n\n` : "";
    }
    if (/^(p|div|section|article|blockquote|figure|figcaption)$/.test(tag)) {
      const value = inner.trimEnd();
      return value ? `${value}\n` : "\n";
    }

    return inner;
  }

  function isImageOnlyLink(link, href) {
    const text = normalizeInline(link.innerText || link.textContent || "");
    if (text) {
      return false;
    }
    if (link.querySelector("img, picture, source")) {
      return true;
    }
    return /\.(?:avif|gif|jpe?g|png|webp)(?:[?#].*)?$/i.test(String(href || ""));
  }

  function formatMemoMarkdown(memos) {
    const lines = [
      "# 네이버 메모 내보내기",
      "",
      `- 내보낸 시각: ${new Date().toLocaleString()}`,
      `- 메모 수: ${memos.length}`,
      `- 원본: ${MEMO_LIST_URL}`,
      ""
    ];

    memos.forEach((memo, index) => {
      lines.push(
        "---",
        "",
        `## ${index + 1}. ${headingText(memo.title)}`,
        "",
        `- 날짜: ${oneLine(memo.date) || "알 수 없음"}`,
        ...(memo.modified ? [`- 수정: ${oneLine(memo.modified)}`] : []),
        `- 폴더: ${oneLine(memo.category) || "알 수 없음"}`,
        `- 메모 ID: ${oneLine(memo.id)}`,
        `- URL: ${oneLine(memo.url)}`,
        "",
        memo.content ? memo.content : "_내용 없음._",
        ""
      );
    });

    return `${lines.join("\n").replace(/\n{4,}/g, "\n\n\n").trim()}\n`;
  }

  function formatBlogMarkdown(posts, context) {
    const scopeLabel = context.visibility === "all" ? "공개 + 비공개 글" : "공개 글만";
    const categoryLabel = (context.categories || [])
      .map((category) => category.name)
      .filter(Boolean)
      .join(", ") || "전체 카테고리";
    const lines = [
      "# 네이버 블로그 내보내기",
      "",
      `- 내보낸 시각: ${new Date().toLocaleString()}`,
      `- 블로그 ID: ${context.blogId}`,
      `- 글 수: ${posts.length}`,
      `- 범위: ${scopeLabel}`,
      `- 카테고리: ${categoryLabel}`,
      `- 원본: ${BLOG_ROOT_URL}${context.blogId}`,
      ""
    ];

    posts.forEach((post, index) => {
      lines.push(
        "---",
        "",
        `## ${index + 1}. ${headingText(post.title)}`,
        "",
        `- 날짜: ${oneLine(post.date) || "알 수 없음"}`,
        `- 카테고리: ${oneLine(post.category) || "전체"}`,
        `- 공개 범위: ${blogVisibilityLabel(post.visibility)}`,
        `- 글 번호: ${oneLine(post.logNo)}`,
        `- URL: ${oneLine(post.url)}`,
        "",
        post.content ? post.content : "_내용 없음._",
        ""
      );
    });

    return `${lines.join("\n").replace(/\n{4,}/g, "\n\n\n").trim()}\n`;
  }

  function buildMemoZipEntries(memos) {
    const usedPaths = new Set();
    return memos.map((memo, index) => {
      const folder = safePathSegment(memo.category, "알 수 없음");
      const fileName = individualMarkdownFileName({
        date: memo.date,
        title: memo.title || firstMarkdownLine(memo.content),
        id: memo.id,
        index
      });
      return {
        path: uniqueZipPath(`${folder}/${fileName}`, usedPaths),
        content: formatSingleMemoMarkdown(memo)
      };
    });
  }

  function buildBlogZipEntries(posts) {
    const usedPaths = new Set();
    return posts.map((post, index) => {
      const folder = safePathSegment(post.category, "전체");
      const fileName = individualMarkdownFileName({
        date: post.date,
        title: post.title,
        id: post.logNo,
        index
      });
      return {
        path: uniqueZipPath(`${folder}/${fileName}`, usedPaths),
        content: formatSingleBlogMarkdown(post)
      };
    });
  }

  function formatSingleMemoMarkdown(memo) {
    const lines = [
      `# ${headingText(memo.title)}`,
      "",
      `- 날짜: ${oneLine(memo.date) || "알 수 없음"}`,
      ...(memo.modified ? [`- 수정: ${oneLine(memo.modified)}`] : []),
      `- 폴더: ${oneLine(memo.category) || "알 수 없음"}`,
      `- 메모 ID: ${oneLine(memo.id)}`,
      `- URL: ${oneLine(memo.url)}`,
      "",
      memo.content ? memo.content : "_내용 없음._",
      ""
    ];

    return `${lines.join("\n").replace(/\n{4,}/g, "\n\n\n").trim()}\n`;
  }

  function formatSingleBlogMarkdown(post) {
    const lines = [
      `# ${headingText(post.title)}`,
      "",
      `- 날짜: ${oneLine(post.date) || "알 수 없음"}`,
      `- 카테고리: ${oneLine(post.category) || "전체"}`,
      `- 공개 범위: ${blogVisibilityLabel(post.visibility)}`,
      `- 글 번호: ${oneLine(post.logNo)}`,
      `- URL: ${oneLine(post.url)}`,
      "",
      post.content ? post.content : "_내용 없음._",
      ""
    ];

    return `${lines.join("\n").replace(/\n{4,}/g, "\n\n\n").trim()}\n`;
  }

  function individualMarkdownFileName(item) {
    const datePart = dateTokenForFileName(item.date);
    const prefix = datePart || String((Number(item.index) || 0) + 1).padStart(4, "0");
    const title = safePathSegment(headingText(item.title), "제목 없음", 70);
    const id = safePathSegment(item.id, "", 32);
    return `${prefix}_${title}${id ? `_${id}` : ""}.md`;
  }

  function dateTokenForFileName(value) {
    const text = oneLine(value);
    const match = text.match(/(19\d{2}|20\d{2})\D+(\d{1,2})\D+(\d{1,2})/);
    if (!match) {
      return "";
    }

    const year = match[1];
    const month = String(Number(match[2])).padStart(2, "0");
    const day = String(Number(match[3])).padStart(2, "0");
    const afterDate = text.slice(match.index + match[0].length);
    const timeMatch = afterDate.match(/(오전|오후|am|pm)?\s*(\d{1,2})(?::|시)\s*(\d{1,2})?/i);
    if (!timeMatch) {
      return `${year}${month}${day}`;
    }

    let hour = Number(timeMatch[2]);
    const minute = Number(timeMatch[3] || 0);
    const meridiem = String(timeMatch[1] || "").toLowerCase();
    if (!Number.isFinite(hour) || hour < 0 || hour > 23 || !Number.isFinite(minute) || minute < 0 || minute > 59) {
      return `${year}${month}${day}`;
    }

    if ((meridiem === "오후" || meridiem === "pm") && hour < 12) {
      hour += 12;
    }
    if ((meridiem === "오전" || meridiem === "am") && hour === 12) {
      hour = 0;
    }

    return `${year}${month}${day}_${String(hour).padStart(2, "0")}${String(minute).padStart(2, "0")}`;
  }

  function safePathSegment(value, fallback, maxLength = 80) {
    const clean = oneLine(value)
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
      .replace(/\s+/g, " ")
      .replace(/^\.+|\.+$/g, "")
      .trim()
      .slice(0, maxLength)
      .replace(/[ .]+$/g, "");
    if (!clean || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(clean)) {
      return fallback;
    }
    return clean;
  }

  function uniqueZipPath(path, usedPaths) {
    const normalizedPath = path.replace(/\\/g, "/").replace(/^\/+/, "");
    const key = normalizedPath.toLowerCase();
    if (!usedPaths.has(key)) {
      usedPaths.add(key);
      return normalizedPath;
    }

    const dotIndex = normalizedPath.lastIndexOf(".");
    const base = dotIndex > -1 ? normalizedPath.slice(0, dotIndex) : normalizedPath;
    const extension = dotIndex > -1 ? normalizedPath.slice(dotIndex) : "";
    let suffix = 2;
    while (usedPaths.has(`${base} (${suffix})${extension}`.toLowerCase())) {
      suffix += 1;
    }
    const uniquePath = `${base} (${suffix})${extension}`;
    usedPaths.add(uniquePath.toLowerCase());
    return uniquePath;
  }

  function blogVisibilityLabel(value) {
    return value === "private" ? "비공개/제한 공개" : "공개";
  }

  function downloadText(text, fileName) {
    const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
    downloadBlob(blob, fileName);
  }

  function downloadZip(entries, fileName) {
    downloadBlob(createZipBlob(entries), fileName);
  }

  function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.style.display = "none";
    document.body.append(link);
    link.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      link.remove();
    }, 1000);
  }

  function createZipBlob(entries) {
    const encoder = new TextEncoder();
    const chunks = [];
    const centralRecords = [];
    let offset = 0;
    const { dosTime, dosDate } = zipDateParts(new Date());

    for (const entry of entries) {
      const pathBytes = encoder.encode(entry.path.replace(/\\/g, "/").replace(/^\/+/, ""));
      const data = encoder.encode(entry.content || "");
      const crc = crc32(data);

      const localHeader = new Uint8Array(30 + pathBytes.length);
      const localView = new DataView(localHeader.buffer);
      localView.setUint32(0, 0x04034b50, true);
      localView.setUint16(4, 20, true);
      localView.setUint16(6, 0x0800, true);
      localView.setUint16(8, 0, true);
      localView.setUint16(10, dosTime, true);
      localView.setUint16(12, dosDate, true);
      localView.setUint32(14, crc, true);
      localView.setUint32(18, data.length, true);
      localView.setUint32(22, data.length, true);
      localView.setUint16(26, pathBytes.length, true);
      localView.setUint16(28, 0, true);
      localHeader.set(pathBytes, 30);

      const centralHeader = new Uint8Array(46 + pathBytes.length);
      const centralView = new DataView(centralHeader.buffer);
      centralView.setUint32(0, 0x02014b50, true);
      centralView.setUint16(4, 20, true);
      centralView.setUint16(6, 20, true);
      centralView.setUint16(8, 0x0800, true);
      centralView.setUint16(10, 0, true);
      centralView.setUint16(12, dosTime, true);
      centralView.setUint16(14, dosDate, true);
      centralView.setUint32(16, crc, true);
      centralView.setUint32(20, data.length, true);
      centralView.setUint32(24, data.length, true);
      centralView.setUint16(28, pathBytes.length, true);
      centralView.setUint16(30, 0, true);
      centralView.setUint16(32, 0, true);
      centralView.setUint16(34, 0, true);
      centralView.setUint16(36, 0, true);
      centralView.setUint32(38, 0, true);
      centralView.setUint32(42, offset, true);
      centralHeader.set(pathBytes, 46);

      chunks.push(localHeader, data);
      centralRecords.push(centralHeader);
      offset += localHeader.length + data.length;
    }

    const centralStart = offset;
    for (const record of centralRecords) {
      chunks.push(record);
      offset += record.length;
    }

    const endRecord = new Uint8Array(22);
    const endView = new DataView(endRecord.buffer);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(4, 0, true);
    endView.setUint16(6, 0, true);
    endView.setUint16(8, centralRecords.length, true);
    endView.setUint16(10, centralRecords.length, true);
    endView.setUint32(12, offset - centralStart, true);
    endView.setUint32(16, centralStart, true);
    endView.setUint16(20, 0, true);
    chunks.push(endRecord);

    return new Blob(chunks, { type: "application/zip" });
  }

  function zipDateParts(date) {
    return {
      dosTime: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
      dosDate: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
    };
  }

  function crc32(data) {
    const table = crc32.table || (crc32.table = buildCrc32Table());
    let crc = 0xffffffff;
    for (const byte of data) {
      crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function buildCrc32Table() {
    const table = new Uint32Array(256);
    for (let value = 0; value < 256; value += 1) {
      let crc = value;
      for (let bit = 0; bit < 8; bit += 1) {
        crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
      }
      table[value] = crc >>> 0;
    }
    return table;
  }

  function normalizeExportMode(value) {
    return value === "separate" ? "separate" : "combined";
  }

  function normalizeDownloadFileName(value, kind, exportMode) {
    const fallback = defaultFileName(kind, exportMode);
    const clean = String(value || fallback)
      .trim()
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
      .replace(/\s+/g, " ");
    if (!clean) {
      return fallback;
    }
    return withDownloadExtension(clean, exportMode === "separate" ? ".zip" : ".md");
  }

  function withDownloadExtension(value, extension) {
    return `${String(value || "").trim().replace(/\.(?:md|zip)$/i, "")}${extension}`;
  }

  function defaultFileName(kind, exportMode = "combined") {
    const prefix = kind === "blog" ? "네이버_블로그" : kind === "memo" ? "네이버_메모" : "네이버_백업";
    const extension = exportMode === "separate" ? "zip" : "md";
    return `${prefix}_${dateStamp()}.${extension}`;
  }

  function dateStamp() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  }

  function cleanText(el) {
    return cleanMultiline(el ? el.innerText || el.textContent || "" : "");
  }

  function cleanMultiline(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  }

  function cleanDate(value) {
    return oneLine(value)
      .replace(/^(작성|수정|날짜|일시|created|updated|date)\s*:?/i, "")
      .trim();
  }

  function firstMarkdownLine(value) {
    return String(value || "")
      .split("\n")
      .map((line) => line.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s*|\d+\.\s+)/, "").trim())
      .find(Boolean) || "";
  }

  function headingText(value) {
    return oneLine(value).replace(/^#+\s*/, "") || "제목 없음";
  }

  function oneLine(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function normalizeInline(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function escapeBracketText(value) {
    return String(value || "").replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
  }

  function emitScroll(el) {
    el.dispatchEvent(new Event("scroll", { bubbles: true }));
  }

  function waitFor(check, timeoutMs, intervalMs, timeoutMessage) {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        try {
          if (check()) {
            resolve();
            return;
          }
        } catch (error) {
          reject(error);
          return;
        }

        if (Date.now() - started >= timeoutMs) {
          reject(new Error(timeoutMessage || "화면 업데이트를 기다리는 중 시간이 초과되었습니다."));
          return;
        }
        setTimeout(tick, intervalMs);
      };
      tick();
    });
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function sendProgress(done, total, message, label, unit) {
    try {
      chrome.runtime.sendMessage({
        type: "NAVER_EXPORT_PROGRESS",
        done,
        total,
        message,
        label,
        unit
      });
    } catch (_) {
      // 팝업이 닫혀도 내보내기는 계속 진행됩니다.
    }
  }

  function safeValue(read) {
    try {
      return read() || "";
    } catch (_) {
      return "";
    }
  }
})();
