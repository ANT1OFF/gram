/**
 * Common English words, and the everyday words of software, that dictation never turns into a
 * name on its own: "set state" stays prose, while "use dictation" can become `useDictation`
 * because "dictation" isn't here. Generous on purpose: a word wrongly here costs a missed
 * replacement, a word wrongly missing costs a wrong one.
 */
export const COMMON_WORDS: ReadonlySet<string> = new Set(
  `a able about above accept access account across act action active actually add added address
  admit adult affect after afternoon again against age agency agent ago agree ahead air all
  allow almost alone along already also although always am amount an analysis and animal
  another answer any anyone anything anyway app appear apply approach area argue arm around
  arrive art article artist as ask assume at attack attention author available avoid away
  baby back bad bag ball bank bar base be beat beautiful because become bed been before begin
  behavior behind believe below best better between beyond big bill bit black blank block blood
  blue board body book born both box boy break bring brother brown budget build building built
  business but buy by call camera campaign can cancel cancer candidate capital car card care
  career carry case catch cause cell center central century certain chair challenge chance
  change character charge chat check child choice choose church citizen city civil claim class
  clean clear clearly click clip clock close coach code cold collection college color column
  come command comment commit common community company compare computer concern condition
  config conference congress consider consumer contain content context continue control copy
  cost could country couple course court cover create crime cultural culture cup current
  customer cut dark data date daughter day dead deal death debate decade decide decision deep
  default defense degree delete democrat describe design despite detail determine develop
  development device die diff difference different difficult dinner direction director
  discover discuss discussion disease do doctor document does dog doing done door dot down
  draft draw dream drive drop drug during each early east easy eat economic economy edge edit
  education effect effort eight either election else employee empty end energy enjoy enough
  enter entire entry environment environmental error especially establish even evening event
  ever every everybody everyone everything evidence exactly example executive exist expect
  experience expert explain eye face fact factor fail fall family far fast father fear federal
  feel feeling few field fight figure fill film final finally financial find fine finger
  finish fire firm first fish five fix flag floor flow fly focus folder follow food foot for
  force foreign forget form format former forward found four free friend from front full fund
  function future game garden gas general generation get girl give glass go goal going good got
  government great green ground group grow growth guess gun guy hair half hand handle hang
  happen happy hard has have he head health hear heard heart heat heavy hello help her here
  herself hey hi high him himself his history hit hold home hope hospital hot hotel hour house
  how however huge human hundred husband i idea identify if image imagine impact important
  improve in include including increase indeed index indicate individual industry info input output
  information inside instead institution interest interesting international interview into
  investment involve is issue it item its itself job join just keep key kid kill kind kitchen
  know knowledge land language large last late later laugh law lawyer lay layer lead leader
  learn least leave left leg legal less let letter level lie life light like likely line link
  list listen little live load local long look lose loss lot love low machine magazine main
  maintain major majority make man manage management manager many map mark market marriage
  match material matter may maybe me mean measure media medical meet meeting member memory
  mention menu merge message method middle might military million mind minute miss mission
  mode model modern moment money month more morning most mother mouth move movement movie mr
  mrs much music must my myself name names nation national natural nature near nearly
  necessary need network never new news newspaper next nice night no node none nor north not
  note nothing notice now number object occur of off offer office officer official often oh oil
  ok okay old on once one only onto open operation opportunity option or order organization
  other others our out outside over own owner page pain painting panel paper parent part
  particular particularly partner party pass past paste path patient pattern pay peace people
  per perform performance perhaps period person personal phone physical pick picture piece
  place plan plant play player please point police policy political politics poor popular
  population position positive possible post power practice prepare present president
  pressure pretty prevent price print private probably problem process produce product
  production professional professor program project property protect prove provide public
  pull purpose push put quality query question quick quickly quiet quite race radio raise range
  rate rather reach read ready real reality realize really reason receive recent recently
  recognize record red reduce reflect region relate relationship release religious remain
  remember remove render reply report represent republican request require research resource
  respond response responsibility rest result return reveal rich right rise risk road rock role
  room root round row rule run safe said same save saw say scene school science scientist
  score screen sea search season seat second secret section security see seek seem seen sell
  send senior sense series serious serve server service session set setting settings seven
  several sex sexual shake shall share she shell shoot short shot should shoulder show side
  sign significant similar simple simply since sing single sister sit site situation six size
  skill skin slow small smile so social society soldier some somebody someone something
  sometimes son song soon sort sound source south southern space speak special specific speech
  spend sport spring staff stage stand standard star start state statement station status stay
  step still stock stop store story strategy street string strong structure student study stuff
  style subject success successful such suddenly suffer suggest summer support sure surface
  switch system tab table take talk target task tax teach teacher team technology television
  tell ten tend term terminal test text than thank thanks that the their them themselves then
  theory there these they thing things think third this those though thought thousand thread
  threat three through throughout throw thus time title to today together tomorrow tonight too
  took top total tough toward town trade traditional training travel treat treatment tree trial
  trip trouble true truth try turn tv two type under understand unit until up update upon us
  use used user using usually valid value various very victim view violence visit voice vote
  wait walk wall want war watch water way we weapon wear week weight well went were west
  western what whatever when where whether which while white who whole whom whose why wide
  wife will win wind window wish with within without woman wonder word words work worker
  workspace world worry would write writer wrong yard yeah year yes yet you young your
  yourself zero app apps async await bug bugs cache class client const data debug docs enum
  fetch file files flag folder font fork git hook host json key lint log logs main mock note
  null open parse path port prop props pull push queue react route schema script shell sort
  spec sync tag test tests token tool tools trace type types undo view web worker append
  audio auth badge batch board body branch buffer button char chip chunk component count
  delay deploy dialog download element feature filter frame graph handler header height icon
  inbox install label length listener lock login microphone mic modal option pane patch pause
  payload phase preference prepend profile provider reduce request reset resume retry sample
  secret sidebar skip socket stream stub theme timeout timer toast upload upgrade warning width
  `
    .trim()
    .split(/\s+/),
);
