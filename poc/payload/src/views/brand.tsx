// The Daly brand in Payload's admin (the owner's logo pack, public/brand): the mark in the header and the
// full logo on the sign-in page, instead of Payload's own.
export function DalyIcon() {
  // An image rather than inline SVG: Payload's header styles recolour inline SVG shapes.
  // eslint-disable-next-line @next/next/no-img-element
  return <img alt="Daly" className="daly-icon" height={26} src="/brand/favicon.svg" width={26} />
}

export function DalyLogo() {
  // eslint-disable-next-line @next/next/no-img-element
  return <img alt="Daly" className="daly-logo" height={90} src="/brand/daly-logo-colour.svg" width={218} />
}
