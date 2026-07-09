import { io } from "socket.io-client";

const hostname = window.location.hostname || "localhost";
const isViteDevServer = window.location.port === "5173";

export const SERVER_URL = isViteDevServer ? `http://${hostname}:3001` : window.location.origin;

export const socket = io(SERVER_URL, {
  autoConnect: false
});
