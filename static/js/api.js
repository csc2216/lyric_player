export async function getLibrary() {
  const res = await fetch("/api/library");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
