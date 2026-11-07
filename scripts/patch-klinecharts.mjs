// Lets drawings and order lines sit left/right of the loaded candles: outside
// the data, indexes and timestamps are extrapolated with the bar interval the
// app stores in chartStore.barInterval (ms). Same patch as tradingMind's
// vendored klinecharts-9.8.12.js. Runs after npm install.
import { readFileSync, writeFileSync } from "node:fs";

const files = ["node_modules/klinecharts/dist/index.esm.js"]; // what bundlers load ("module")
const OLD_TS = `    TimeScaleStore.prototype.dataIndexToTimestamp = function (dataIndex) {
        var _a;
        var data = this.getDataByDataIndex(dataIndex);
        return (_a = data === null || data === void 0 ? void 0 : data.timestamp) !== null && _a !== void 0 ? _a : null;
    };
    TimeScaleStore.prototype.timestampToDataIndex = function (timestamp) {
        var dataList = this._chartStore.getDataList();
        if (dataList.length === 0) {
            return 0;
        }
        return binarySearchNearest(dataList, 'timestamp', timestamp);
    };`;
const NEW_TS = `    // backtestmind patch
    TimeScaleStore.prototype.dataIndexToTimestamp = function (dataIndex) {
        var dataList = this._chartStore.getDataList();
        var n = dataList.length;
        var step = this._chartStore.barInterval;
        if (n === 0) {
            return null;
        }
        if (dataIndex >= n && step) {
            return dataList[n - 1].timestamp + (dataIndex - n + 1) * step;
        }
        if (dataIndex < 0 && step) {
            return dataList[0].timestamp + dataIndex * step;
        }
        var data = this.getDataByDataIndex(dataIndex);
        return data ? data.timestamp : null;
    };
    TimeScaleStore.prototype.timestampToDataIndex = function (timestamp) {
        var dataList = this._chartStore.getDataList();
        var n = dataList.length;
        var step = this._chartStore.barInterval;
        if (n === 0) {
            return 0;
        }
        if (step && timestamp > dataList[n - 1].timestamp) {
            return n - 1 + Math.floor((timestamp - dataList[n - 1].timestamp) / step);
        }
        if (step && timestamp < dataList[0].timestamp) {
            return -Math.ceil((dataList[0].timestamp - timestamp) / step);
        }
        var lo = 0, hi = n - 1;
        while (lo < hi) {
            var mid = (lo + hi + 1) >> 1;
            if (dataList[mid].timestamp <= timestamp) { lo = mid; } else { hi = mid - 1; }
        }
        return lo;
    };`;

for (const f of files) {
  const src = readFileSync(f, "utf8");
  if (src.includes("backtestmind patch")) continue;
  if (!src.includes(OLD_TS)) throw new Error(`klinecharts patch: code not found in ${f}`);
  writeFileSync(f, src.replace(OLD_TS, NEW_TS));
  console.log("patched", f);
}
