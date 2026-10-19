// Research loader adapter: preserve honest OKX provenance; change no validation maths.
export const originalSourceGuard="c.provenance?.source !== 'pacifica' || c.provenance.venue !== 'pacifica'";
export const researchSourceGuard="!['pacifica','okx'].includes(c.provenance?.source) || c.provenance.venue !== c.provenance.source";
export function allowResearchProxyPolicy(source){
  if(source.split(originalSourceGuard).length!==2)throw Error('Research source guard boundary changed');
  return source.replace(originalSourceGuard,researchSourceGuard);
}