import { atom } from "nanostores";

export const $autoScroll = atom(false);
export const $autoCorrects = atom("โมนัด=>monad");

// Save $autoCorrects to sessionStorage
$autoCorrects.subscribe((value) => {
  sessionStorage.setItem("autoCorrects", value);
});
if (sessionStorage.getItem("autoCorrects")) {
  $autoCorrects.set(sessionStorage.getItem("autoCorrects")!);
}
