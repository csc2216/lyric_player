import { getLibrary } from "./api.js";

const status = document.getElementById("status");

try {
  const tree = await getLibrary();
  status.textContent = `後端連線正常，歌曲庫中有 ${tree.length} 位歌手。`;
} catch (err) {
  status.textContent = `無法連線後端：${err.message}`;
}
