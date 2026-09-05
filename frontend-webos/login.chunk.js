"use strict";(self.webpackChunkstremio_theater=self.webpackChunkstremio_theater||[]).push([[6966],{1912:(n,e,t)=>{t.r(e),t.d(e,{default:()=>j});var r=t(9151),i=t(9225),l=(t(8579),t(2432),t(5585)),o=t(1088),s=t(9132),a=t(6870),d=t(289),c=t(8327),g=t(1157),u=t(43),h=t.n(u),f=t(5920),m=t.n(f),k=t(3004),v=t.n(k),p=t(7419),b=t.n(p),w=t(1663),_=t.n(w),C=t(1612),I=t.n(C),R=t(3693),Z={};Z.styleTagTransform=I(),Z.setAttributes=b(),Z.insert=v().bind(null,"head"),Z.domAPI=m(),Z.insertStyleElement=_(),h()(R.A,Z);const x=R.A&&R.A.locals?R.A.locals:void 0;var T=(0,r.vs)("<div>"),E=(0,r.vs)("<div> "),P=(0,r.vs)("<div><div>1</div><div>"),y=(0,r.vs)("<div><div>2</div><div>"),K=(0,r.vs)("<div><div>Profiles</div><div>");var PIN_ROOT=(0,r.vs)("<div><img><div></div><div></div><div></div><div>"),PIN_DOT=(0,r.vs)("<div>");
const PIN_KEYS=[
{type:"digit",value:"1"},
{type:"digit",value:"2"},
{type:"digit",value:"3"},
{type:"digit",value:"4"},
{type:"digit",value:"5"},
{type:"digit",value:"6"},
{type:"digit",value:"7"},
{type:"digit",value:"8"},
{type:"digit",value:"9"},
{type:"clear"},
{type:"digit",value:"0"},
{type:"delete"}
],
PinModalLite=e=>{
const{t:n}=(0,l.B)(),
[digits,setDigits]=(0,i.n5)([]),
[busy,setBusy]=(0,i.n5)(!1),
submitTimer=(0,c.SR)(500),
unlockTimer=(0,c.SR)(500),

addDigit=n=>{
if(busy())return;
setDigits(current=>{
if(current.length>=4)return current;
const next=[...current,n];
if(4===next.length){
submitTimer(()=>{
const pin=next.join("");
if(!busy()){
setBusy(!0);
setDigits([]);
e.onSubmit&&e.onSubmit(pin);
unlockTimer(()=>setBusy(!1))
}
})
}
return next
})
},

press=e=>{
"digit"===e.type&&addDigit(e.value);
"clear"===e.type&&!busy()&&(submitTimer(),setDigits([]));
"delete"===e.type&&!busy()&&(submitTimer(),setDigits(e=>e.slice(0,-1)))
},

directKey=e=>{
let digit=null;

if(e.key>="0"&&e.key<="9"){
digit=e.key
}else if(e.keyCode>=48&&e.keyCode<=57){
digit=String(e.keyCode-48)
}else if(e.keyCode>=96&&e.keyCode<=105){
digit=String(e.keyCode-96)
}

if(null!==digit){
e.preventDefault();
e.stopPropagation();
e.stopImmediatePropagation&&e.stopImmediatePropagation();
addDigit(digit);
return
}

if("Backspace"===e.key||8===e.keyCode||"Delete"===e.key||46===e.keyCode){
e.preventDefault();
e.stopPropagation();
e.stopImmediatePropagation&&e.stopImmediatePropagation();
press({type:"delete"})
}
};

(0,i.Rc)(()=>{
window.addEventListener("keydown",directKey,!0);

/*
 * De modal/keypad verschijnt pas nadat de navigation components
 * gemount zijn. Forceer daarna meerdere layout recalculations.
 */
setTimeout(()=>window.dispatchEvent(new Event("resize")),50);
setTimeout(()=>window.dispatchEvent(new Event("resize")),150);
setTimeout(()=>window.dispatchEvent(new Event("resize")),350)
});

(0,i.Ki)(()=>{
window.removeEventListener("keydown",directKey,!0)
});

return(0,i.a0)(g.aF,{
get onClose(){return e.onClose},
get children(){
var root=PIN_ROOT(),
avatar=root.firstChild,
name=avatar.nextSibling,
title=name.nextSibling,
dots=title.nextSibling,
keypad=dots.nextSibling;

(0,r.s7)(root,"profile-pin-modal");
(0,r.s7)(avatar,"profile-pin-avatar");
(0,r.s7)(name,"profile-pin-name");
(0,r.s7)(title,"profile-pin-title");
(0,r.s7)(dots,"profile-pin-dots");
(0,r.s7)(keypad,"profile-pin-keypad");

(0,i.gb)(()=>{
const src=e.avatar;
if(src){
avatar.style.display="";
(0,r.Bq)(avatar,"src",src)
}else{
avatar.style.display="none"
}
});

(0,r.Yr)(name,()=>e.name||"");

(0,r.Yr)(title,()=>{
const text=n("USER_PROFILES_ENTER_PIN");
return text&&"USER_PROFILES_ENTER_PIN"!==text?text:"Enter PIN"
});

(0,r.Yr)(dots,(0,i.a0)(i.a,{
get each(){return Array(4)},
children:(e,n)=>{
var dot=PIN_DOT();
(0,i.gb)(()=>(0,r.s7)(
dot,
"profile-pin-dot"+(digits()[n()]?" filled":"")
));
return dot
}
}),null);

(0,r.Yr)(keypad,(0,i.a0)(i.a,{
each:PIN_KEYS,
children:(e,n)=>(0,i.a0)(a.zo,{
get class(){
return"profile-pin-key"+("digit"!==e.type?" action":"")
},
layoutUpdate:!0,
get autoFocus(){return 0===n()},
onPress:()=>press(e),
onClick:()=>press(e),
get children(){
return"digit"===e.type?e.value:"clear"===e.type?"×":"⌫"
}
})
}),null);

return root
}
})
};

const j=()=>{const{t:n}=(0,l.B)(),e=(0,o.W6)(),t=(0,o.lq)(),{on:u,off:h}=(0,a.cq)(),f=(0,d.Vj)(),{ctx:m,authLink:k}=(0,s.gK)(),{load:v,unload:p,readData:b,info:w,authKey:_}=k,[C,I]=(0,i.n5)(3e5),[pinProfile,setPinProfile]=(0,i.n5)(null),R=()=>{var n;return null===(n=w())||void 0===n?void 0:n.qrcode},Z=()=>{var n;return"profiles"===(null===(n=t())||void 0===n?void 0:n.name)},j=()=>{var e,t;return null!==(e=null===(t=m.user())||void 0===t?void 0:t.email)&&void 0!==e?e:n("ACCOUNT")},N=()=>m.profiles?m.profiles():[],W=()=>{const n=m.selectedProfile&&m.selectedProfile();return n&&n.name?"Current: "+n.name:"Choose a profile"},A=n=>{console.error("[profiles] Failed to switch profile:",n),window.alert("Could not switch profile. Check the PIN and try again.")},O=()=>{const n=Math.floor(C()/6e4%60),e=Math.floor(C()/1e3%60);return`${n}:${e<10?"0":""}${e}`},S=()=>window.location.reload(),q=()=>{Z()?(pinProfile()?setPinProfile(null):e.navigate("/home",!0)):f.quit()},B=n=>{Z()&&461===n.keyCode&&(n.preventDefault(),n.stopPropagation(),n.stopImmediatePropagation&&n.stopImmediatePropagation(),n.returnValue=!1,pinProfile()?setPinProfile(null):e.navigate("/home",!0))};return(0,i.EH)(()=>{const n=_();!Z()&&n&&m.authenticate(n)}),(0,i.EH)(()=>{m.isAuthenticated()&&!Z()&&e.navigate(m.hasPremium&&m.hasPremium()?"/profiles":"/home",!0)}),(0,i.EH)(()=>{Z()&&p()}),(0,i.EH)(()=>{!Z()&&C()<=0&&S()}),(0,c.WW)(()=>{Z()||b()},3e3),(0,c.WW)(()=>{Z()||I(n=>n-1e3)},1e3),(0,i.Rc)(()=>{Z()||v(),u("back",q),window.addEventListener("keydown",B,!0)}),(0,i.Ki)(()=>{p(),h("back",q),window.removeEventListener("keydown",B,!0)}),(0,i.a0)(g.YW,{get class(){return x.login},get children(){return(0,i.a0)(i.wv,{get when(){return Z()},get fallback(){return[(e=T(),(0,r.Yr)(e,()=>n("STREMIO_TV_LOGIN_TITLE")),(0,i.gb)(()=>(0,r.s7)(e,x.title)),e),(0,i.a0)(i.wv,{get when(){return R()},get fallback(){return(0,i.a0)(g.Rh,{get class(){return x.loading}})},get children(){return[(0,i.a0)(g._V,{get class(){return x.qrcode},get src(){return R()}}),(e=E(),t=e.firstChild,(0,r.Yr)(e,()=>n("STREMIO_TV_LOGIN_EXPIRES_IN"),t),(0,r.Yr)(e,O,null),(0,i.gb)(()=>(0,r.s7)(e,x.timer)),e),(0,i.a0)(a.Gk,{get class(){return x.steps},get children(){return[(o=P(),s=o.firstChild,a=s.nextSibling,(0,r.Yr)(a,()=>n("STREMIO_TV_LOGIN_STEP_ONE"),null),(0,r.Yr)(a,(0,i.a0)(g.N_,{get href(){return null===(n=w())||void 0===n?void 0:n.link;var n}}),null),(0,i.gb)(n=>{var e=x.step,t=x.count,i=x.label;return e!==n.e&&(0,r.s7)(o,n.e=e),t!==n.t&&(0,r.s7)(s,n.t=t),i!==n.a&&(0,r.s7)(a,n.a=i),n},{e:void 0,t:void 0,a:void 0}),o),(e=y(),t=e.firstChild,l=t.nextSibling,(0,r.Yr)(l,()=>n("STREMIO_TV_LOGIN_STEP_TWO")),(0,i.gb)(n=>{var i=x.step,o=x.count,s=x.label;return i!==n.e&&(0,r.s7)(e,n.e=i),o!==n.t&&(0,r.s7)(t,n.t=o),s!==n.a&&(0,r.s7)(l,n.a=s),n},{e:void 0,t:void 0,a:void 0}),e)];var e,t,l,o,s,a}}),(0,i.a0)(g.$n,{get class(){return x.button},icon:"add",get label(){return n("STREMIO_TV_LOGIN_NEW_LINK")},autoFocus:!0,onPress:S})];var e,t}})];var e},get children(){return[(n=K(),e=n.firstChild,t=e.nextSibling,t.remove(),(0,i.gb)(()=>(0,r.s7)(n,x.login+" profiles-lite-header")),(0,i.gb)(()=>(0,r.s7)(e,x.title)),n),(0,i.a0)(i.wv,{
get when(){return N().length},
get fallback(){return(0,i.a0)(g.Rh,{get class(){return x.loading}})},
get children(){
return(0,i.a0)(a.Gk,{
class:"profiles-lite-list",
get children(){
return(0,i.a0)(i.a,{
get each(){return N()},
children:(n,e)=>(0,i.a0)(g.$n,{
class:"profiles-lite-button",
get avatar(){
if(!n)return null;
if(n.gravatar)return n.gravatar;
const t=n.avatar;
return Number.isInteger(t)&&t>=0&&t<=11
?`https://www.stremio.com/images/avatars/avatar-${t}.png`
:null
},
icon:"person",
get label(){return n&&n.name||j()},
get autoFocus(){return 0===e()},
onPress:()=>{
const e=n&&(n._id||n.id);
if(!e||!m.switchProfile)return;

if(n.hasPin){
setPinProfile(n);
return
}

try{
Promise.resolve(m.switchProfile(e)).catch(A)
}catch(n){
A(n)
}
}
})
})
}
})
}
}),
(0,i.a0)(i.wv,{
get when(){return pinProfile()},
keyed:!0,
children:n=>(0,i.a0)(PinModalLite,{
get avatar(){
if(!n)return null;
if(n.gravatar)return n.gravatar;
const e=n.avatar;
return Number.isInteger(e)&&e>=0&&e<=11
?`https://www.stremio.com/images/avatars/avatar-${e}.png`
:null
},
get name(){return n&&n.name||j()},
onClose:()=>setPinProfile(null),
onSubmit:t=>{
const e=n&&(n._id||n.id);
if(!e||!m.switchProfile)return;

try{
Promise.resolve(m.switchProfile(e,t)).catch(A)
}catch(n){
A(n)
}
}
})
})];var n,e,t}})}})}},3693:(n,e,t)=>{t.d(e,{A:()=>s});var r=t(5556),i=t.n(r),l=t(3645),o=t.n(l)()(i());o.push([n.id,".login-Zkkl4 {\n  display: flex;\n  flex-direction: column;\n  justify-content: center;\n  align-items: center;\n}\n.login-Zkkl4 > * {\n  margin: 0.75em 0 0.75em 0;\n}\n.login-Zkkl4 > :first-child {\n  margin-top: 0;\n}\n.login-Zkkl4 > :last-child {\n  margin-bottom: 0;\n}\n.login-Zkkl4 .title-aZ_Ai {\n  font-size: 2rem;\n  font-weight: bold;\n  color: hsla(0, 0%, 100%, 0.9);\n}\n.login-Zkkl4 .loading-zx8Ye {\n  height: 10rem;\n  width: 10rem;\n}\n.login-Zkkl4 .qrcode-Wd5Jx {\n  height: 18rem;\n  width: 18rem;\n  border-radius: 1em;\n  background-color: rgba(255, 255, 255, 0.03);\n}\n.login-Zkkl4 .timer-UaDJy {\n  font-size: 1.8rem;\n  font-weight: 500;\n  color: hsla(0, 0%, 100%, 0.5);\n}\n.login-Zkkl4 .steps-Cj23R {\n  display: flex;\n  flex-direction: column;\n}\n.login-Zkkl4 .steps-Cj23R > * {\n  margin: 0.75rem 0 0.75rem 0;\n}\n.login-Zkkl4 .steps-Cj23R > :first-child {\n  margin-top: 0;\n}\n.login-Zkkl4 .steps-Cj23R > :last-child {\n  margin-bottom: 0;\n}\n.login-Zkkl4 .steps-Cj23R .step-I8K2n {\n  flex: auto;\n  display: flex;\n  flex-direction: row;\n  align-items: center;\n}\n.login-Zkkl4 .steps-Cj23R .step-I8K2n > * {\n  margin: 0 0.5rem 0 0.5rem;\n}\n.login-Zkkl4 .steps-Cj23R .step-I8K2n > :first-child {\n  margin-left: 0;\n}\n.login-Zkkl4 .steps-Cj23R .step-I8K2n > :last-child {\n  margin-right: 0;\n}\n.login-Zkkl4 .steps-Cj23R .step-I8K2n .count-zrUJz {\n  flex: none;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  height: calc(4rem - 1rem);\n  width: calc(4rem - 1rem);\n  font-size: 1.6rem;\n  font-weight: 600;\n  line-height: 1rem;\n  border-radius: 100%;\n  color: hsla(0, 0%, 100%, 0.9);\n  background-color: rgba(255, 255, 255, 0.03);\n}\n.login-Zkkl4 .steps-Cj23R .step-I8K2n .label-qWAC9 {\n  flex: auto;\n  display: flex;\n  flex-direction: row;\n  align-items: center;\n  font-size: 1.8rem;\n  font-weight: 500;\n  color: hsla(0, 0%, 100%, 0.9);\n}\n.login-Zkkl4 .button-RfKWK {\n  width: auto;\n  margin-top: 2rem;\n}\n",""]),o.locals={login:"login-Zkkl4",title:"title-aZ_Ai",loading:"loading-zx8Ye",qrcode:"qrcode-Wd5Jx",timer:"timer-UaDJy",steps:"steps-Cj23R",step:"step-I8K2n",count:"count-zrUJz",label:"label-qWAC9",button:"button-RfKWK"};const s=o}}]);