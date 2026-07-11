# -*- coding: utf-8 -*-
"""
抓取微信公众号(及一般网页)正文，输出 JSON。绕过微信"环境异常"验证页——用真实 Chromium 渲染。

用法:
    python fetch_wechat.py "<url>" [--out out.json]

依赖 playwright + chromium:
    pip install playwright && playwright install chromium

输出字段: ok / url / title / author / publish / content / note
"""
import sys, json, re, argparse

def extract(page, url):
    # 微信文章标准结构
    js = """() => {
        const pick = (sel) => { const el = document.querySelector(sel); return el ? el.innerText.trim() : ""; };
        const meta = (p) => { const el = document.querySelector(`meta[property='${p}'], meta[name='${p}']`); return el ? el.content.trim() : ""; };
        let title = pick('#activity-name') || meta('og:title') || (document.title||'').trim();
        let author = pick('#js_name') || meta('author') || meta('og:article:author') || "";
        let publish = pick('#publish_time') || meta('article:published_time') || "";
        // 微信有时把发布时间放在脚本变量里
        if (!publish) {
            const m = (document.documentElement.innerHTML||'').match(/var\\s+(?:oriCreateTime|ct|createTime)\\s*=\\s*['\"]([^'\"]+)['\"]/);
            if (m) publish = m[1];
        }
        // 正文
        const c = document.querySelector('#js_content') || document.querySelector('article') || document.querySelector('.rich_media_content');
        let content = "";
        if (c) {
            const blocks = [];
            c.querySelectorAll('p, h1, h2, h3, h4, li, blockquote').forEach(el => {
                const t = (el.innerText||'').trim();
                if (t) blocks.push(el.tagName.match(/^H/) ? ('## ' + t) : t);
            });
            content = blocks.join('\\n\\n') || (c.innerText||'').trim();
        }
        return {title, author, publish, content, hasContentEl: !!c};
    }"""
    data = page.evaluate(js)
    body_txt = page.evaluate("() => document.body ? document.body.innerText : ''") or ""
    blocked = any(k in body_txt for k in ["环境异常", "去验证", "请升级", "参数错误", "该内容已被发布者删除", "此内容因违规无法查看"])
    ok = bool(data.get("content")) and len(data.get("content", "")) > 60 and not blocked
    note = ""
    if blocked and not data.get("content"):
        note = "疑似验证页/内容异常(环境异常/已删除/违规)，请人工核对或重试"
    elif not data.get("hasContentEl"):
        note = "未找到正文容器(#js_content)，可能非公众号文章或结构变化"
    return {
        "ok": ok, "url": url,
        "title": data.get("title", ""), "author": data.get("author", ""),
        "publish": data.get("publish", ""), "content": data.get("content", ""),
        "note": note,
    }

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("url")
    ap.add_argument("--out", default=None)
    ap.add_argument("--timeout", type=int, default=45000)
    args = ap.parse_args()
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print(json.dumps({"ok": False, "url": args.url, "note": "当前解释器缺 playwright: pip install playwright && playwright install chromium"}, ensure_ascii=False))
        sys.exit(2)

    result = {"ok": False, "url": args.url, "note": "unknown"}
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
            locale="zh-CN", viewport={"width": 1280, "height": 900})
        page = ctx.new_page()
        try:
            page.goto(args.url, wait_until="domcontentloaded", timeout=args.timeout)
            page.wait_for_timeout(2500)
            result = extract(page, args.url)
            if not result["ok"] and "验证" in (result.get("note") or ""):
                # 重试一次
                page.reload(wait_until="domcontentloaded", timeout=args.timeout)
                page.wait_for_timeout(3000)
                result = extract(page, args.url)
        except Exception as e:
            result = {"ok": False, "url": args.url, "note": f"抓取异常: {e}"}
        finally:
            browser.close()

    out = json.dumps(result, ensure_ascii=False, indent=1)
    if args.out:
        open(args.out, "w", encoding="utf-8").write(out)
        print(json.dumps({"ok": result["ok"], "savedTo": args.out, "title": result.get("title", ""), "chars": len(result.get("content", "")), "note": result.get("note", "")}, ensure_ascii=False))
    else:
        print(out)

if __name__ == "__main__":
    main()
