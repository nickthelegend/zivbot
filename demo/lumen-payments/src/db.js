// In-memory stand-in for billing-db. Every call to query() is one round trip,
// and in production each round trip costs ~2ms — so query count is latency.
export function createDb(seed) {
  const tables = structuredClone(seed);
  let queries = 0;
  return {
    get queryCount() { return queries; },
    resetCount() { queries = 0; },
    /** select rows from a table matching every key in `where` (arrays mean IN). */
    query(table, where = {}) {
      queries++;
      return (tables[table] || []).filter((row) =>
        Object.entries(where).every(([k, v]) => (Array.isArray(v) ? v.includes(row[k]) : row[k] === v)),
      );
    },
  };
}
