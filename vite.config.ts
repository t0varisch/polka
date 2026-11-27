import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
	// Относительные пути: приложение работает из любой подпапки (GitHub Pages)
	base: "./",
	build: { target: "es2020" },
	plugins: [
		VitePWA({
			registerType: "autoUpdate",
			includeAssets: ["icon.svg", "apple-touch-icon.png"],
			manifest: {
				name: "Полка — книги тремя способами",
				short_name: "Полка",
				description: "Книги тремя способами: страницами, по слову, печатая",
				lang: "ru",
				// своё имя приложения: относительный id считается от адреса сайта, «./» у Полки, Точки и Печатки давал одно приложение на троих
				id: "/polka/",
				start_url: "./",
				scope: "./",
				display: "standalone",
				background_color: "#1b1e24",
				theme_color: "#1b1e24",
				icons: [
					{ src: "icon-192.png", sizes: "192x192", type: "image/png" },
					{ src: "icon-512.png", sizes: "512x512", type: "image/png" },
					{ src: "icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
				],
			},
			workbox: {
				globPatterns: ["**/*.{js,mjs,css,html,woff2,png,svg}"],
				// pdf.js с воркером весит больше стандартных 2 МБ
				maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
			},
		}),
	],
});
