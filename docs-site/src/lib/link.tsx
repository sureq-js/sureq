import {
  Link as RouterLink,
  type LinkProps as RouterLinkProps,
} from 'react-router'

type AppLinkProps = Omit<RouterLinkProps, 'to'> & {
  href: RouterLinkProps['to']
}

export function Link({ href, ...props }: AppLinkProps) {
  return <RouterLink to={href} {...props} />
}