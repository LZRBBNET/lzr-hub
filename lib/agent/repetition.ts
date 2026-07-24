export function normalizeResponse(text:string){return text.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9\s]/g," ").replace(/\s+/g," ").trim()}
function ngrams(text:string,size=3){const words=normalizeResponse(text).split(" ").filter(Boolean);const result=new Set<string>();for(let i=0;i<=words.length-size;i++)result.add(words.slice(i,i+size).join(" "));return result}
export function jaccardSimilarity(a:string,b:string){const left=ngrams(a);const right=ngrams(b);if(!left.size&&!right.size)return 1;const intersection=[...left].filter(item=>right.has(item)).length;return intersection/(left.size+right.size-intersection||1)}
export function openingSimilarity(a:string,b:string){return jaccardSimilarity(normalizeResponse(a).split(" ").slice(0,8).join(" "),normalizeResponse(b).split(" ").slice(0,8).join(" "))}
export function questionCount(text:string){return(text.match(/\?/g)??[]).length}
export function repetitionScore(response:string,recent:string[]){if(!recent.length)return 0;return Math.max(...recent.slice(-3).map(item=>Math.max(jaccardSimilarity(response,item),openingSimilarity(response,item)*.85)))}
/** @deprecated Use the evidence-aware validator in evidence.ts. */
export function hasFalseActionClaim(response:string,completedTools:number){return completedTools===0&&/\b(gerei|enviei|anexei|abri|desbloqueei|agendei|executei)\b/i.test(response)}
