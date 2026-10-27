const prices = [
    [/^claude-(fable|mythos)-5/, { input: 10, output: 50, cacheRead: 0.25 }],
    [/^claude-opus-5-5/, { input: 4, output: 20, cacheRead: 0.2 }],
    [/^claude-opus-(5|4-[678])/, { input: 5, output: 25, cacheRead: 0.5 }],
    [/^claude-sonnet-5/, { input: 2, output: 10, cacheRead: 0.2 }],
    [/^claude-sonnet-4-6/, { input: 3, output: 15, cacheRead: 0.3 }],
    [/^claude-haiku-5-5/, { input: 0.1, output: 0.5, cacheRead: 0.01 }],
    [/^claude-haiku-4-5/, { input: 1, output: 5, cacheRead: 0.1 }],
];
export function price(model, usage) {
    const p = prices.find(([re]) => re.test(model))?.[1];
    if (!p)
        return undefined;
    const m = 1e-6;
    return usage.input * p.input * m + (usage.cacheWrite ?? 0) * p.input * 1.25 * m + (usage.cacheRead ?? 0) * p.cacheRead * m + usage.output * p.output * m;
}
export const dollars = (n) => (n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
export const count = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
