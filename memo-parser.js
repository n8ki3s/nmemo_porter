"use strict";

// 이 확장이 내보낸 네이버 메모 마크다운(.md)과 ZIP을 다시 메모 단위로 나눕니다.
(function (root) {
  const EMPTY_CONTENT = "_내용 없음._";
  const UNKNOWN = "알 수 없음";
  const NL = String.fromCharCode(10);

  // 하나의 .md 파일 → 메모 배열. fileName은 제목을 못 찾을 때만 씁니다.
  function parseMemoMarkdown(text, fileName = "") {
    const source = String(text || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");

    if (/^# 네이버 블로그 내보내기\s*$/m.test(source.split("\n", 1)[0])) {
      throw new Error(`${fileName || "파일"}: 블로그 백업 파일은 메모로 가져올 수 없습니다.`);
    }

    if (/^# 네이버 메모 내보내기\s*$/.test(source.split("\n", 1)[0])) {
      return parseCombined(source);
    }

    const single = parseSection(source, /^# (.*)$/m);
    if (single) {
      return [single];
    }

    return [parseGeneric(source, fileName)];
  }

  // "하나의 파일로" 형식: 메모마다 "---" 다음에 "## 번호. 제목"과 "- 날짜:" 줄이 옵니다.
  function parseCombined(source) {
    const marker = /(?:^|\n)---\n\n(## \d+\. [^\n]*\n\n- 날짜: )/g;
    const starts = [];
    let match;
    while ((match = marker.exec(source))) {
      starts.push(match.index + match[0].length - match[1].length);
    }

    return starts
      .map((start, index) => {
        const end = index + 1 < starts.length ? starts[index + 1] : source.length;
        const chunk = source.slice(start, end).replace(/\n---\n*$/, "");
        return parseSection(chunk, /^## \d+\. (.*)$/m);
      })
      .filter(Boolean);
  }

  // 제목 줄 + "- 키: 값" 메타데이터 줄 + 빈 줄 + 본문
  function parseSection(chunk, headingPattern) {
    const lines = chunk.split("\n");
    let index = lines.findIndex((line) => line.trim() !== "");
    if (index < 0) {
      return null;
    }

    const heading = lines[index].match(new RegExp(headingPattern.source));
    if (!heading) {
      return null;
    }
    index += 1;

    while (index < lines.length && lines[index].trim() === "") {
      index += 1;
    }

    const meta = {};
    while (index < lines.length) {
      const metaMatch = lines[index].match(/^- (날짜|수정|폴더|메모 ID|URL): ?(.*)$/);
      if (!metaMatch) {
        break;
      }
      meta[metaMatch[1]] = metaMatch[2].trim();
      index += 1;
    }

    if (!("날짜" in meta)) {
      return null;
    }

    const content = lines.slice(index).join("\n").replace(/^\n+/, "").replace(/\s+$/, "");
    return {
      title: normalizeTitle(heading[1]),
      date: normalizeMeta(meta["날짜"]),
      folder: normalizeMeta(meta["폴더"]),
      id: meta["메모 ID"] || "",
      url: meta.URL || "",
      content: content === EMPTY_CONTENT ? "" : content
    };
  }

  // 이 확장 형식이 아닌 일반 마크다운: 첫 제목(없으면 파일명)을 제목으로 씁니다.
  function parseGeneric(source, fileName) {
    const lines = source.split("\n");
    const headingIndex = lines.findIndex((line) => /^#{1,6} \S/.test(line));
    let title = "";
    let body = source;
    if (headingIndex >= 0 && lines.slice(0, headingIndex).every((line) => line.trim() === "")) {
      title = lines[headingIndex].replace(/^#{1,6} /, "");
      body = lines.slice(headingIndex + 1).join("\n");
    } else {
      title = String(fileName || "").replace(/^.*[\\/]/, "").replace(/\.(?:md|markdown|txt)$/i, "");
    }
    return {
      title: normalizeTitle(title),
      date: "",
      folder: "",
      id: "",
      url: "",
      content: body.replace(/^\n+/, "").replace(/\s+$/, "")
    };
  }

  function normalizeTitle(value) {
    const title = String(value || "").trim();
    return title === "제목 없음" ? "" : title;
  }

  function normalizeMeta(value) {
    const text = String(value || "").replace(/^일시\s*:\s*/, "").trim();
    return text === UNKNOWN ? "" : text;
  }

  // 가져올 순서: 원래 만들어진 순서(오래된 것 먼저)로 만들어야 목록에서 원래 순서가 됩니다.
  // 메모 ID가 모두 숫자면 ID 오름차순, 아니면 내보낸 순서(최신이 위)를 뒤집습니다.
  function orderForImport(memos) {
    const list = memos.slice();
    if (list.length && list.every((memo) => /^\d+$/.test(memo.id))) {
      return list.sort((a, b) => Number(a.id) - Number(b.id));
    }
    return list.reverse();
  }

  // 네이버 메모의 제목 없는 메모는 title이 ""이고 글 전체가 memoContent에 들어 있습니다.
  // 내보내기는 그런 메모에도 본문 첫 줄을 제목으로 채워 넣었으므로,
  // 백업 제목이 본문 첫 줄(또는 목록에서 잘린 첫 줄)이면 빈 제목으로 되돌립니다.
  // 따로 붙인 제목이면 그대로 두고, 어느 경우든 본문은 전체를 memoContent로 보냅니다.
  // 원래 생성일시는 본문 맨 끝에 빈 줄 하나를 두고 남깁니다.
  function buildNaverMemo(memo, keepMeta) {
    let content = trimBlankLines(memo.content);
    const firstLine = (content.split(NL).find((line) => line.trim()) || "").trim();
    const backupTitle = String(memo.title || "").trim();
    const title = backupTitle && !isTitleFromFirstLine(backupTitle, firstLine) ? backupTitle : "";

    const meta = keepMeta ? metaLine(memo) : "";
    if (meta) {
      content = content ? content + NL + NL + meta : meta;
    }
    return { title, content };
  }

  // 앞쪽 빈 줄과 끝쪽 공백을 지웁니다(첫 줄의 들여쓰기는 남김).
  function trimBlankLines(value) {
    const lines = String(value || "").split(NL);
    while (lines.length && !lines[0].trim()) {
      lines.shift();
    }
    return lines.join(NL).trimEnd();
  }

  // 백업 제목이 본문 첫 줄 그대로이거나, 목록에서 잘려 보인 첫 줄("..."로 끝남)인지 확인합니다.
  function isTitleFromFirstLine(title, firstLine) {
    const squash = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const head = squash(title).replace(/\s*(?:\.{2,}|…)$/, "");
    return !!head && squash(firstLine).startsWith(head);
  }

  // 본문과 구분되도록 빈 줄 하나 뒤에 "[생성일시]"만 남깁니다.
  function metaLine(memo) {
    return memo.date ? `[${memo.date}]` : "";
  }

  // ---- ZIP 읽기 (저장/deflate 방식 지원) ----

  async function readZipMarkdownEntries(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const view = new DataView(arrayBuffer);
    const endOffset = findEndOfCentralDirectory(view);
    if (endOffset < 0) {
      throw new Error("ZIP 파일 형식을 읽지 못했습니다.");
    }

    const count = view.getUint16(endOffset + 10, true);
    let offset = view.getUint32(endOffset + 16, true);
    const entries = [];

    for (let index = 0; index < count; index += 1) {
      if (view.getUint32(offset, true) !== 0x02014b50) {
        throw new Error("ZIP 목록을 읽는 중 오류가 났습니다.");
      }
      const flags = view.getUint16(offset + 8, true);
      const method = view.getUint16(offset + 10, true);
      const compressedSize = view.getUint32(offset + 20, true);
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      const localOffset = view.getUint32(offset + 42, true);
      const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
      const name = decodeName(nameBytes, flags);
      offset += 46 + nameLength + extraLength + commentLength;

      if (name.endsWith("/") || !/\.(?:md|markdown|txt)$/i.test(name) || /(^|\/)(__MACOSX|\.)/.test(name)) {
        continue;
      }

      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const data = bytes.subarray(dataStart, dataStart + compressedSize);

      let raw;
      if (method === 0) {
        raw = data;
      } else if (method === 8) {
        raw = await inflateRaw(data);
      } else {
        throw new Error(`${name}: 지원하지 않는 ZIP 압축 방식입니다.`);
      }
      entries.push({ name, text: new TextDecoder("utf-8").decode(raw) });
    }

    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  function findEndOfCentralDirectory(view) {
    const minOffset = Math.max(0, view.byteLength - 22 - 0xffff);
    for (let offset = view.byteLength - 22; offset >= minOffset; offset -= 1) {
      if (view.getUint32(offset, true) === 0x06054b50) {
        return offset;
      }
    }
    return -1;
  }

  function decodeName(nameBytes, flags) {
    if (flags & 0x0800) {
      return new TextDecoder("utf-8").decode(nameBytes);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(nameBytes);
    } catch (_) {
      return new TextDecoder("euc-kr").decode(nameBytes);
    }
  }

  async function inflateRaw(data) {
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  const api = {
    parseMemoMarkdown,
    orderForImport,
    buildNaverMemo,
    readZipMarkdownEntries
  };

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.MemoParser = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
