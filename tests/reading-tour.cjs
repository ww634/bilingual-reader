const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync('app/js/reading-tour.js', 'utf8').replace(/^import .*;$/gm, '').replace(/export /g, '') + '\nglobalThis.place=placeTourCard;';
const context = vm.createContext({}); vm.runInContext(source, context);

test('tour cards fit phone widths and safe areas above or below their highlighted control', () => {
  for (const width of [320, 375, 430, 1280]) {
    for (const height of [568, 812]) {
      for (const cardHeight of [230, 310, 400]) {
        for (const rect of [
          { left: 16, top: 78, bottom: 108, width: 28 },
          { left: width - 54, top: 20, bottom: 64, width: 44 },
          { left: width / 2 - 30, top: height - 48, bottom: height - 24, width: 60 },
        ]) {
          const p = context.place(rect, width, height, cardHeight, 20, height - 34);
          assert.ok(p.left >= 16 && p.left + p.width <= width - 16);
          assert.ok(p.top >= 20 && p.top + cardHeight <= height - 34);
          assert.ok(p.top >= rect.bottom || p.top + cardHeight <= rect.top);
        }
      }
    }
  }
});
