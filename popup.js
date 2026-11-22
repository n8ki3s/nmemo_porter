"use strict";

const MEMO_URL = "https://memo.naver.com/?viewType=LIST";
const BLOG_URL = "https://blog.naver.com/MyBlog.naver";

const pageState = document.getElementById("pageState");
const statusEl = document.getElementById("status");
const exportModeSelect = document.getElementById("exportMode");
const fileNameInput = document.getElementById("fileName");
const blogOptions = document.getElementById("blogOptions");
const blogVisibilitySelect = document.getElementById("blogVisibility");
const blogCategoryOptions = document.getElementById("blogCategoryOptions");
const blogCategoriesSelect = document.getElementById("blogCategories");
const exportButton = document.getElementById("exportButton");
const openMemoButton = document.getElementById("openMemoButton");
const openBlogButton = document.getElementById("openBlogButton");

let lastAutoFileName = "";
let categoryLoadId = 0;
let currentTarget = "";

document.addEventListener("DOMContentLoaded", async () => {
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);

  openMemoButton.addEventListener("click", () => {
    chrome.tabs.create({ url: MEMO_URL });
  });

  openBlogButton.addEventListener("click", () => {
    chrome.tabs.create({ url: BLOG_URL });
  });

  document.getElementById("openImportButton").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("import.html") });
  });

  exportModeSelect.addEventListener("change", () => {
    setDefaultFileName(currentTarget || "backup", { forceExtension: true });
  });

  exportButton.addEventListener("click", exportCurrentTab);
  await refreshPageState();
});

function handleRuntimeMessage(message) {
  if (!message || message.type !== "NAVER_EXPORT_PROGRESS") {
    return;
  }

  const total = message.total || "?";
  const done = message.done || 0;
  if (message.unit === "post") {
    setStatus(`포스트 ${total}개 중 ${done}개\n${message.message || ""}`, "");
  } else {
    const label = message.label || "항목";
    setStatus(`${label} 내보내는 중 ${done}/${total}\n${message.message || ""}`, "");
  }
}

async function refreshPageState(options = {}) {
  const tab = await getActiveTab();
  const url = tab && tab.url ? tab.url : "";
  const target = pageTarget(url);
  const isMemoPage = target === "memo";
  const isBlogPage = target === "blog";
  const canExport = isMemoPage || isBlogPage;
  currentTarget = target;

  setDefaultFileName(target);

  exportButton.disabled = !canExport;
  openMemoButton.disabled = isMemoPage;
  openBlogButton.disabled = isBlogPage;
  blogOptions.classList.toggle("hidden", !isBlogPage);
  blogCategoryOptions.classList.toggle("hidden", !isBlogPage);

  if (isMemoPage) {
    pageState.textContent = "현재 탭: 네이버 메모";
    pageState.className = "page-state ok";
    if (!options.preserveStatus) {
      setStatus("마크다운 내보내기를 누르면 메모를 저장합니다.", "");
    }
  } else if (isBlogPage) {
    pageState.textContent = "현재 탭: 네이버 블로그";
    pageState.className = "page-state ok";
    if (!options.preserveStatus) {
      setStatus("카테고리와 범위를 선택한 뒤 블로그 글을 저장할 수 있습니다.", "");
    }
    await loadBlogCategories(tab.id, options.preserveStatus);
  } else {
    pageState.textContent = "네이버 메모 또는 네이버 블로그를 열어 주세요.";
    pageState.className = "page-state warn";
    if (!options.preserveStatus) {
      setStatus("아래 버튼으로 이동한 뒤 로그인하고 다시 실행해 주세요.", "warn");
    }
  }
}

async function exportCurrentTab() {
  const tab = await getActiveTab();
  if (!tab || typeof tab.id !== "number") {
    setStatus("활성 탭을 찾지 못했습니다.", "error");
    return;
  }

  const target = pageTarget(tab.url || "");
  if (!target) {
    setStatus("네이버 메모 또는 네이버 블로그 탭에서 실행해 주세요.", "error");
    return;
  }

  exportButton.disabled = true;
  openMemoButton.disabled = true;
  openBlogButton.disabled = true;
  setStatus("내보내기를 준비 중입니다...", "");

  try {
    await ensureContentScript(tab.id);
    const response = await sendTabMessage(tab.id, {
      type: "EXPORT_NAVER_DATA",
      options: {
        target,
        exportMode: selectedExportMode(),
        fileName: fileNameInput.value,
        blogVisibility: blogVisibilitySelect.value,
        blogCategories: selectedBlogCategories(),
        delayMs: target === "memo" ? 450 : 250,
        maxScrolls: 500,
        maxPages: 1000
      }
    });

    if (!response || !response.ok) {
      throw new Error((response && response.error) || "내보내기에 실패했습니다.");
    }

    const label = response.label || (target === "blog" ? "블로그 글" : "메모");
    setStatus(`${label} ${response.count}개를 저장했습니다.\n${response.fileName}`, "ok");
  } catch (error) {
    setStatus(error.message || String(error), "error");
  } finally {
    await refreshPageState({ preserveStatus: true });
  }
}

async function loadBlogCategories(tabId, preserveStatus) {
  const loadId = categoryLoadId + 1;
  categoryLoadId = loadId;
  setCategoryOptions([{ categoryNo: "0", name: "전체 카테고리", count: 0 }]);
  blogCategoriesSelect.disabled = true;

  try {
    await ensureContentScript(tabId);
    const response = await sendTabMessage(tabId, { type: "GET_NAVER_BLOG_CATEGORIES" });
    if (loadId !== categoryLoadId) {
      return;
    }
    if (!response || !response.ok) {
      throw new Error((response && response.error) || "카테고리를 불러오지 못했습니다.");
    }

    setCategoryOptions(response.categories || []);
    if (!preserveStatus) {
      const count = Math.max(0, (response.categories || []).length - 1);
      setStatus(count ? `카테고리 ${count}개를 불러왔습니다.` : "전체 카테고리로 내보낼 수 있습니다.", "");
    }
  } catch (error) {
    if (loadId !== categoryLoadId) {
      return;
    }
    setCategoryOptions([{ categoryNo: "0", name: "전체 카테고리", count: 0 }]);
    if (!preserveStatus) {
      setStatus(error.message || String(error), "warn");
    }
  } finally {
    if (loadId === categoryLoadId) {
      blogCategoriesSelect.disabled = false;
    }
  }
}

function setCategoryOptions(categories) {
  const previous = new Set(selectedBlogCategories().map((category) => category.categoryNo));
  const list = normalizeCategoryOptions(categories);
  blogCategoriesSelect.textContent = "";

  for (const category of list) {
    const option = document.createElement("option");
    option.value = category.categoryNo;
    option.textContent = category.count > 0
      ? `${category.name} (${category.count})`
      : category.name;
    option.dataset.name = category.name;
    option.dataset.count = String(category.count || 0);
    option.selected = previous.size ? previous.has(category.categoryNo) : category.categoryNo === "0";
    blogCategoriesSelect.append(option);
  }

  if (!Array.from(blogCategoriesSelect.selectedOptions).length && blogCategoriesSelect.options.length) {
    blogCategoriesSelect.options[0].selected = true;
  }
}

function normalizeCategoryOptions(categories) {
  const seen = new Set();
  const list = [];
  const source = Array.isArray(categories) && categories.length
    ? categories
    : [{ categoryNo: "0", name: "전체 카테고리", count: 0 }];

  const add = (category) => {
    const categoryNo = String(category.categoryNo || "").trim();
    const name = String(category.name || "").trim();
    if (!categoryNo || !name) {
      return;
    }
    if (seen.has(categoryNo)) {
      const previous = list.find((item) => item.categoryNo === categoryNo);
      if (previous) {
        previous.count = previous.count || Number(category.count || 0);
      }
      return;
    }
    seen.add(categoryNo);
    list.push({
      categoryNo,
      name,
      count: Number(category.count || 0)
    });
  };

  add({ categoryNo: "0", name: "전체 카테고리", count: 0 });
  source.forEach(add);
  return list;
}

function selectedBlogCategories() {
  const selected = Array.from(blogCategoriesSelect.selectedOptions).map((option) => ({
    categoryNo: option.value,
    name: option.dataset.name || option.textContent.replace(/\s*\(\d+\)\s*$/, ""),
    count: Number(option.dataset.count || 0)
  }));
  const specific = selected.filter((category) => category.categoryNo !== "0");
  return specific.length ? specific : selected.filter((category) => category.categoryNo === "0");
}

async function ensureContentScript(tabId) {
  try {
    await sendTabMessage(tabId, { type: "PING" });
    return;
  } catch (_) {
    await chromePromise((resolve) => {
      chrome.scripting.executeScript(
        { target: { tabId }, files: ["content.js"] },
        resolve
      );
    });
    await sleep(150);
    await sendTabMessage(tabId, { type: "PING" });
  }
}

function getActiveTab() {
  return chromePromise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs && tabs[0]);
    });
  });
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

function pageTarget(url) {
  if (/^https:\/\/memo\.naver\.com\//i.test(url)) {
    return "memo";
  }
  if (/^https:\/\/(?:m\.)?blog\.naver\.com\//i.test(url)) {
    return "blog";
  }
  return "";
}

function setDefaultFileName(target, options = {}) {
  const next = defaultFileName(target || "backup", selectedExportMode());
  if (!fileNameInput.value || fileNameInput.value === lastAutoFileName) {
    fileNameInput.value = next;
    lastAutoFileName = next;
    return;
  }

  if (options.forceExtension) {
    fileNameInput.value = withFileExtension(fileNameInput.value, selectedFileExtension());
  }
}

function setStatus(message, className) {
  statusEl.textContent = message;
  statusEl.className = className ? `status ${className}` : "status";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function selectedExportMode() {
  return exportModeSelect.value === "separate" ? "separate" : "combined";
}

function selectedFileExtension() {
  return selectedExportMode() === "separate" ? ".zip" : ".md";
}

function withFileExtension(value, extension) {
  const clean = String(value || "").trim();
  if (!clean) {
    return clean;
  }
  return `${clean.replace(/\.(?:md|zip)$/i, "")}${extension}`;
}

function defaultFileName(target, exportMode) {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const stamp = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate())
  ].join("") + "_" + [pad(now.getHours()), pad(now.getMinutes()), pad(now.getSeconds())].join("");
  const extension = exportMode === "separate" ? "zip" : "md";

  if (target === "memo") {
    return `네이버_메모_${stamp}.${extension}`;
  }
  if (target === "blog") {
    return `네이버_블로그_${stamp}.${extension}`;
  }
  return `네이버_백업_${stamp}.${extension}`;
}
