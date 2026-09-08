import { Link, useLocation } from "wouter";

export function NavBar({
  menu,
  onClick,
  itemClassName = "",
}: {
  menu: boolean;
  onClick?: () => void;
  itemClassName?: string;
}) {
  const [location] = useLocation();

  return (
    <>
      <NavItem menu={menu} onClick={onClick} itemClassName={itemClassName} title="blog" selected={location === "/" || location.startsWith("/feed")} href="/" />
      <NavItem menu={menu} onClick={onClick} itemClassName={itemClassName} title="timeline" selected={location === "/timeline"} href="/timeline" />
      <NavItem menu={menu} onClick={onClick} itemClassName={itemClassName} title="tags" selected={location === "/hashtags"} href="/hashtags" />
      <NavItem menu={menu} onClick={onClick} itemClassName={itemClassName} title="about" selected={location === "/about"} href="/about" />
    </>
  );
}

function NavItem({
  menu,
  title,
  selected,
  href,
  when = true,
  onClick,
  itemClassName = "",
}: {
  title: string;
  selected: boolean;
  href: string;
  menu?: boolean;
  when?: boolean;
  onClick?: () => void;
  itemClassName?: string;
}) {
  return when ? (
    <Link
      href={href}
      className={`${menu ? "" : "hidden"} md:block cursor-pointer hover:text-theme duration-300 px-2 py-4 md:p-4 text-sm ${
        selected ? "text-theme" : "dark:text-white"
      } ${itemClassName}`}
      state={{ animate: true }}
      onClick={onClick}
    >
      {title}
    </Link>
  ) : null;
}
