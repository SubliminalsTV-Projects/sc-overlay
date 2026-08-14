#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = process.argv[2];
if (!path) {
  console.error('usage: converge-missions-043.cjs <missions.html>');
  process.exit(2);
}
let html = fs.readFileSync(path, 'utf8');
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

if (!html.includes('window.__overlayClassifyPoint = classifyOverlayPoint;')) {
  const startNeedle = '    const RSEL = "body.scanbox #scanBox, body.boardbox #boardBox, body.payoutscan #payoutPanel,';
  const start = html.indexOf(startNeedle);
  must(start >= 0, '0.1.43 RSEL block with boardBox not found');

  const endNeedle = '      reportRegions();\n';
  const endAt = html.indexOf(endNeedle, start);
  must(endAt >= 0, 'legacy reportRegions tail not found');
  const end = endAt + endNeedle.length;

  const block = `    const RSEL = "body.scanbox #scanBox, body.boardbox #boardBox, body.payoutscan #payoutPanel, #panel, #globalCog, #hub, #cogMenu, #whatsnew, #setupNudge.show, #svcDown.show, #ocrWarn.show, #arrangeScrim .ab, #arrangeScrim .nudge, .widget:not(.notifier), .widget.notifier.live, .widget.notifier.moving, .widget.notifier.cfgopen, .widget:hover .whead, .widget.touched .whead, .widget.grouped .whead, #panel:hover .whead, #panel.touched .whead, #panel.grouped .whead";
      // ARCHVERSE_043_REGION_CLASSIFIER: Linux shell receives semantic hit-test metadata, not just
      // rectangles. Calibration overlays remain gated by their body modes, including 0.1.43 boardBox.
      const pointTargetVisible = (el) => {
        if (!el || !el.isConnected) return false;
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
        const r = el.getBoundingClientRect();
        return r.width > 1 && r.height > 1;
      };
      const notifierCanTakeFocus = (el) => !el.classList.contains("notifier")
        || el.classList.contains("live")
        || el.classList.contains("moving")
        || el.classList.contains("cfgopen");
      const describeRegionElement = (el) => {
        const widget = el.closest?.(".widget");
        if (widget && pointTargetVisible(widget) && notifierCanTakeFocus(widget)) {
          const key = widget.id.startsWith("w-") ? widget.id.slice(2) : (widget.dataset.widgetKey || "widget");
          return {
            key,
            title: WBY[key]?.title || widget.querySelector(".wh-title")?.textContent?.trim() || key,
            classification: widget.classList.contains("notifier") ? ".widget.notifier" : ".widget",
            id: widget.id || null,
            classes: [...widget.classList],
            priority: widget.classList.contains("notifier") ? 35 : 30,
          };
        }
        const panel = el.closest?.("#panel");
        if (panel && pointTargetVisible(panel)) {
          return {
            key: "blueprint", title: WBY.blueprint?.title || "Mission & BP Tracker",
            classification: "#panel", id: "panel", classes: [...panel.classList], priority: 25,
          };
        }
        const chrome = el.closest?.("body.scanbox #scanBox, body.boardbox #boardBox, body.payoutscan #payoutPanel, #globalCog, #hub, #cogMenu, #whatsnew, #setupNudge.show, #svcDown.show, #ocrWarn.show, #arrangeScrim .ab, #arrangeScrim .nudge");
        if (chrome && pointTargetVisible(chrome)) {
          return {
            key: chrome.id || "overlay-chrome",
            title: chrome.getAttribute("aria-label") || chrome.getAttribute("title") || chrome.id || "Overlay controls",
            classification: "overlay-chrome", id: chrome.id || null,
            classes: [...chrome.classList], priority: 50,
          };
        }
        return null;
      };
      const collectOverlayRegions = () => {
        const rects = [];
        document.querySelectorAll(RSEL).forEach((el) => {
          const meta = describeRegionElement(el);
          if (!meta) return;
          const r = el.getBoundingClientRect();
          if (r.width > 1 && r.height > 1) rects.push({ x: r.left, y: r.top, w: r.width, h: r.height, ...meta });
        });
        return rects;
      };
      let lastRegions = "";
      const reportRegions = (force = false, _reason = "layout-change") => {
        const rects = collectOverlayRegions();
        const sig = JSON.stringify(rects);
        if (!force && sig === lastRegions) return rects.length;
        lastRegions = sig;
        window.overlayApi.reportRegions(rects);
        return rects.length;
      };
      window.__overlayReportRegions = reportRegions;
      let regionFrame = 0;
      const scheduleRegionReport = (reason = "layout-change") => {
        if (regionFrame) return;
        regionFrame = requestAnimationFrame(() => {
          regionFrame = 0;
          reportRegions(false, reason);
        });
      };
      const resized = new WeakSet();
      const regionResizeObserver = new ResizeObserver(() => scheduleRegionReport("resize-observer"));
      const observeRegionNodes = () => {
        document.querySelectorAll(RSEL).forEach((el) => {
          if (resized.has(el)) return;
          resized.add(el);
          regionResizeObserver.observe(el);
        });
      };
      const regionMutationObserver = new MutationObserver(() => {
        observeRegionNodes();
        scheduleRegionReport("mutation-observer");
      });
      regionMutationObserver.observe(document.body, {
        subtree: true, childList: true, attributes: true,
        attributeFilter: ["class", "style", "hidden"],
      });
      window.addEventListener("resize", () => scheduleRegionReport("window-resize"));
      document.addEventListener("transitionend", () => scheduleRegionReport("transition-end"), true);
      document.addEventListener("animationend", () => scheduleRegionReport("animation-end"), true);
      document.fonts?.ready?.then(() => scheduleRegionReport("fonts-ready"));
      observeRegionNodes();
      reportRegions(true, "startup");
      const classifyOverlayPoint = (x, y) => {
        if (!Number.isFinite(x) || !Number.isFinite(y)
            || x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) {
          return { hit: false, classification: "transparent-canvas" };
        }
        const matches = collectOverlayRegions().filter((r) =>
          x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h);
        if (!matches.length) return { hit: false, classification: "transparent-canvas" };
        matches.sort((a, b) => (b.priority - a.priority) || ((a.w * a.h) - (b.w * b.h)));
        return { hit: true, ...matches[0] };
      };
      window.__overlayClassifyPoint = classifyOverlayPoint;
      window.overlayApi.onProbePoint?.((point) => {
        const seq = Number(point?.seq);
        const result = classifyOverlayPoint(Number(point?.x), Number(point?.y));
        window.overlayApi.reportPointClassification?.({ seq, ...result });
      });
`;

  html = html.slice(0, start) + block + html.slice(end);
}

if (!html.includes('<script src="/archverse-widget-appearance.js"></script>')) {
  const body = '</body>';
  must(html.includes(body), 'missions.html closing body missing');
  html = html.replace(body, '  <script src="/archverse-widget-appearance.js"></script>\n' + body);
}

must(html.includes('body.boardbox #boardBox'), 'upstream boardBox was lost during Linux convergence');
must(html.includes('ARCHVERSE_043_REGION_CLASSIFIER'), 'Linux region classifier marker missing');
must(html.includes('window.__overlayClassifyPoint = classifyOverlayPoint;'), 'point classifier export missing');
must(!html.includes('setInterval(reportRegions, 100);'), 'old 10Hz region polling survived convergence');
fs.writeFileSync(path, html);
console.log('0.1.43 missions interaction classifier converged and verified');
