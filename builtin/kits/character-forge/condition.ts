/** character-forge kit gate.
 *
 *  全局默认 enabled —— 5 个工具自己会校验 slug / charId / env key。
 *  如果未来想"无 ARK_IMAGE_KEY / GEMINI_API_KEY 就隐藏" 也只需要在这里
 *  读 process.env 决定返回值，BaseKitLoader 会把它和 tool 自己的 condition
 *  AND 起来。 */

export default function condition(): boolean {
  return true;
}
