import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export async function calculateHash(data: any): Promise<string> {
  const encoder = new TextEncoder();
  // 정렬된 JSON 문자열을 사용하여 일관된 해시 생성
  const dataString = JSON.stringify(data, Object.keys(data).sort());
  const dataBuffer = encoder.encode(dataString);
  const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
