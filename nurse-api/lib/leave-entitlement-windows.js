const { validDate, addDays } = require("./configured-scheduler");

function requestWindows(period, from, to) {
  if (!validDate(from) || !validDate(to) || to < from)
    throw new Error("Invalid entitlement request dates");
  const windows = [];
  for (let date = from; date <= to; ) {
    const year = Number(date.slice(0, 4));
    const month = Number(date.slice(5, 7));
    let window;
    if (period === "month") {
      const last = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
      last.setUTCMonth(last.getUTCMonth() + 1);
      last.setUTCDate(0);
      window = {
        start: `${date.slice(0, 7)}-01`,
        end: last.toISOString().slice(0, 10),
        year,
        month,
      };
    } else {
      const leaveYear = month >= 4 ? year : year - 1;
      window = {
        start: `${leaveYear}-04-01`,
        end: `${leaveYear + 1}-03-31`,
        year: leaveYear,
        month: null,
      };
    }
    windows.push(window);
    if (window.end >= to) break;
    date = addDays(window.end, 1);
  }
  return windows;
}
module.exports = { requestWindows };
