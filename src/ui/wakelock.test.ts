import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { idleWakeLock, type WakeLockApi } from "./wakelock";

function fakeApi() {
	const locks: { release: ReturnType<typeof vi.fn>; fire(): void }[] = [];
	const request = vi.fn(async () => {
		let onRelease: () => void = () => {};
		const lock = {
			release: vi.fn(async () => {}),
			addEventListener: (_t: "release", f: () => void) => {
				onRelease = f;
			},
		};
		locks.push({ release: lock.release, fire: () => onRelease() });
		return lock;
	});
	return { api: { request } as WakeLockApi, request, locks };
}

const flush = async () => {
	for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("idleWakeLock", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("poke() дважды подряд запрашивает замок один раз", async () => {
		const { api, request } = fakeApi();
		const w = idleWakeLock(1000, api);
		w.poke();
		w.poke();
		await flush();
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("после простоя замок отпускается", async () => {
		const { api, locks } = fakeApi();
		const w = idleWakeLock(1000, api);
		w.poke();
		await flush();
		vi.advanceTimersByTime(1000);
		expect(locks[0].release).toHaveBeenCalledTimes(1);
	});

	it("poke() перед концом простоя запускает таймер заново", async () => {
		const { api, locks } = fakeApi();
		const w = idleWakeLock(1000, api);
		w.poke();
		await flush();
		vi.advanceTimersByTime(999);
		w.poke();
		vi.advanceTimersByTime(999);
		expect(locks[0].release).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(locks[0].release).toHaveBeenCalledTimes(1);
	});

	it("после снятия замка системой следующий poke() запрашивает снова", async () => {
		const { api, request, locks } = fakeApi();
		const w = idleWakeLock(1000, api);
		w.poke();
		await flush();
		locks[0].fire();
		w.poke();
		await flush();
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("отклонённый запрос не бросает, следующий poke() пробует снова", async () => {
		const request = vi.fn(() => Promise.reject(new Error("no")));
		const w = idleWakeLock(1000, { request } as unknown as WakeLockApi);
		expect(() => w.poke()).not.toThrow();
		await flush();
		w.poke();
		await flush();
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("release() до ответа на запрос отпускает пришедший замок", async () => {
		const { api, locks } = fakeApi();
		const w = idleWakeLock(1000, api);
		w.poke();
		w.release();
		await flush();
		expect(locks[0].release).toHaveBeenCalledTimes(1);
	});

	it("без api ничего не делает и не бросает", () => {
		const w = idleWakeLock(1000, null);
		expect(() => {
			w.poke();
			w.release();
		}).not.toThrow();
	});
});
