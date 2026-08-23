# Mapping reference

Field by field, what goes where. `→` marks a direct mapping, `⇒` one that
involves a decision the converter records as a diagnostic.

## Common conventions

| MT | MX | Note |
| --- | --- | --- |
| Block 1 sender LT address | `AppHdr/Fr/FIId/FinInstnId/BICFI` | BIC11 derived from the 12 character logical terminal |
| Block 2 receiver address | `AppHdr/To/FIId/FinInstnId/BICFI` | |
| Block 2 priority `U`/`S` | `AppHdr/Prty=HIGH`, `PmtTpInf/InstrPrty=HIGH` | `N` gives `NORM` |
| Block 3 `{121:}` | `PmtId/UETR` | ⇒ derived by hashing the message when absent |
| Block 5 `{PDE:}` | `AppHdr/PssblDplct=true` | |
| Field 20 | `MsgId`, `InstrId`, `BizMsgIdr` | |
| Field 32A | `IntrBkSttlmAmt` + `IntrBkSttlmDt` | comma → point; scale checked against ISO 4217 |
| Field 71A `OUR`/`BEN`/`SHA` | `ChrgBr` `DEBT`/`CRED`/`SHAR` | |
| Field 71F / 71G | `ChrgsInf/Amt` + `Agt` | agent is the sender (71F) or receiver (71G) |
| Field 70 | `RmtInf/Ustrd` | split across occurrences at the 140 character limit |
| Field 70 `/ROC/` | `PmtId/EndToEndId` and `RmtInf/Strd/CdtrRefInf/Ref` | ⇒ field 20 is used when absent |
| Field 77B | `RgltryRptg/Authrty/Ctry` + `Dtls/Cd` + `Dtls/Inf` | |
| Field 26T | `Purp/Prtry` | proprietary: MT type codes are not ISO purpose codes |

## Party fields

A party field is read structurally, then placed according to what it turned out
to carry.

| Source | MX |
| --- | --- |
| BIC (option A, or recognised in D/K) | `FinInstnId/BICFI`, or `Id/OrgId/AnyBIC` for a customer |
| `//XX…` clearing code | `FinInstnId/ClrSysMmbId/ClrSysId/Cd` + `MmbId` |
| IBAN account line | `…Acct/Id/IBAN` |
| other account line | `…Acct/Id/Othr/Id` |
| name and address lines | `Nm` + `PstlAdr/AdrLine`, with `Ctry` inferred |
| option F line 1 | `Nm` |
| option F line 2 | `PstlAdr/AdrLine` |
| option F line 3 `XX/TOWN` | `PstlAdr/Ctry` + `PstlAdr/TwnNm` |
| option F line 4 | `Id/PrvtId/DtAndPlcOfBirth/BirthDt` |
| option F line 5 `XX/CITY` | `…/CtryOfBirth` + `…/CityOfBirth` |
| option F lines 6, 7 and `CCPT/…` style identifiers | `Id/PrvtId/Othr` or `Id/OrgId/Othr` with `SchmeNm/Cd` |
| option B location | `FinInstnId/PstlAdr/AdrLine` |

Scheme codes `ARNU`, `CCPT`, `DRLC`, `NIDN` and `SOSE` route to `PrvtId`;
everything else routes to `OrgId`.

### National clearing systems

`//AT`→`ATBLZ`, `//AU`→`AUBSB`, `//BL`→`DEBLZ`, `//CC`→`CACPA`, `//CH`→`USCHU`,
`//CN`→`CNAPS`, `//CP`→`USPID`, `//ES`→`ESNCC`, `//FW`→`USABA`, `//GR`→`GRBIC`,
`//HK`→`HKNCC`, `//IE`→`IENSC`, `//IN`→`INFSC`, `//IT`→`ITNCC`, `//PL`→`PLKNR`,
`//PT`→`PTNCC`, `//RU`→`RUCBC`, `//SC`→`GBDSC`, `//SL`→`CHSIC`, `//SW`→`CHBCC`,
`//ZA`→`ZANCC`. `//RT` is a routing instruction, not a member id.

## Instruction codes

Field 23E and the field 72 code words are split across the ISO elements that
replaced them.

| Code | Target |
| --- | --- |
| `SDVA`, `URGP` | `PmtTpInf/SvcLvl/Cd` |
| `INTC`, `CORT` | `PmtTpInf/CtgyPurp/Cd` |
| `NETS`, `RTGS` | `PmtTpInf/ClrChanl` (`MPNS`, `RTGS`) |
| `CHQB`, `HOLD`, `PHOB`, `TELB` | `InstrForCdtrAgt/Cd` (`Instruction3Code`) |
| `PHON`, `PHOI`, `TELE`, `TELI` | `InstrForNxtAgt/Cd` (`PHOA`, `TELA`) |
| 23B `SPAY`, `SPRI`, `SSTD` | `SvcLvl/Cd` = `SEPA`, `PRPT`, `NURG` |
| 72 `/ACC/` | `InstrForCdtrAgt/InstrInf` |
| 72 `/INT/`, `/REC/` | `InstrForNxtAgt/InstrInf` |
| 72 `/INS/` | `PrvsInstgAgt1` |
| 72 `/BNF/`, `/TSU/` | `RmtInf` |
| 72 `/RETN/`, `/REJT/` | ⇒ warning: this is a return, and belongs in pacs.004 |

Anything unrecognised is carried as instruction text with an `MT.CODE.UNKNOWN_*`
diagnostic — never dropped, never force-fitted.

## Time indications (field 13C)

| Code | Target |
| --- | --- |
| `CLSTIME` | `SttlmTmReq/CLSTm` |
| `TILTIME` | `SttlmTmReq/TillTm` |
| `FROTIME` | `SttlmTmReq/FrTm` |
| `REJTIME` | `SttlmTmReq/RjctTm` |
| `SNDTIME` | `SttlmTmIndctn/DbtDtTm` (date from field 32A) |
| `RNCTIME` | `SttlmTmIndctn/CdtDtTm` |

## MT103 → pacs.008.001.08

| MT | MX |
| --- | --- |
| 50a | `CdtTrfTxInf/Dbtr` + `DbtrAcct` |
| 52a ⇒ sender | `CdtTrfTxInf/DbtrAgt` |
| 56a | `CdtTrfTxInf/IntrmyAgt1` + `IntrmyAgt1Acct` |
| 57a ⇒ receiver | `CdtTrfTxInf/CdtrAgt` + `CdtrAgtAcct` |
| 59a | `CdtTrfTxInf/Cdtr` + `CdtrAcct` |
| 33B | `InstdAmt` |
| 36 | `XchgRate` |
| 77T (REMIT) | ⇒ `SplmtryData/Envlp/Prtry`, with a warning |

## MT202 / MT205 / MT200 → pacs.009.001.08

| MT | MX |
| --- | --- |
| 52a ⇒ sender | `CdtTrfTxInf/Dbtr` (a financial institution here) |
| 56a | `IntrmyAgt1` |
| 57a | `CdtrAgt` |
| 58a | `Cdtr` |
| 21 | `PmtId/EndToEndId` |

MT200 moves the sender's own funds, so both `Dbtr` and `Cdtr` are the sender and
field 57a holds the receiving account.

### COV sequence B → `UndrlygCstmrCdtTrf`

50a → `Dbtr`, 52a → `DbtrAgt`, 56a → `IntrmyAgt1`, 57a → `CdtrAgt`,
59a → `Cdtr`, 70 → `RmtInf`, 33B → `InstdAmt`.

## Settlement method

Derived from which correspondents are named, and always recorded as
`MX.SETTLEMENT_METHOD`:

| Condition | `SttlmMtd` |
| --- | --- |
| 53a names an institution, or 54a / 55a present | `COVE`, with 53a/54a/55a as reimbursement agents |
| 53a carries only an account with a credit mark | `INGA` |
| otherwise | `INDA`, with 53a's account as `SttlmAcct` |

## MT940 / MT950 → camt.053, MT942 → camt.052

| MT | MX |
| --- | --- |
| 25 / 25P | `Stmt/Acct/Id` (+ `Svcr` when a BIC is present) |
| 28C | `LglSeqNb` / `ElctrncSeqNb` |
| 60F, 60M, 62F, 62M, 64, 65 | `Bal` with `OPBD`, `ITBD`, `CLBD`, `ITBD`, `CLAV`, `FWAV` |
| 61 | `Ntry`: `Amt`, `CdtDbtInd`, `RvslInd`, `ValDt`, `BookgDt`, `NtryRef`, `AcctSvcrRef`, `BkTxCd/Prtry` |
| 86 after a 61 | `Ntry/AddtlNtryInf` + `NtryDtls/TxDtls/AddtlTxInf` |
| 86 at the end | `AddtlStmtInf` / `AddtlRptInf` |
| 34F | ⇒ `AddtlRptInf` text: camt has no floor limit element |
| 90C, 90D | `TxsSummry/TtlCdtNtries`, `TtlDbtNtries` |

Entries have no currency of their own; they inherit it from the balance fields,
and a funds code that disagrees is reported.

## MT900 / MT910 → camt.054.001.08

32A → `Ntry/Amt` + `ValDt`; the message type sets `CdtDbtInd` (`DBIT` for MT900,
`CRDT` for MT910); 13D → `BookgDt/DtTm`; 21 → `TxDtls/Refs/EndToEndId`;
50a/52a → `RltdPties/Dbtr` (as `Pty` or `Agt`); 56a → `RltdAgts/IntrmyAgt1`;
72 → `AddtlTxInf`.

## MT210 → camt.057.001.06

20 → `Ntfctn/Id`; 25 → `Ntfctn/Acct`; 30 → `XpctdValDt`. Each repeated sequence
becomes one `Itm`: 21 → `Id`/`EndToEndId`, 32B → `Amt`, 50a → `Dbtr/Pty`,
52a → `Dbtr/Agt` or `DbtrAgt`, 56a → `IntrmyAgt`.

## MT192 → camt.056.001.08

20 → `Assgnmt/Id`; sender and receiver → `Assgnr` / `Assgne`; 21 → `Case/Id`,
`OrgnlInstrId`, `OrgnlEndToEndId`; 11S ⇒ `OrgnlGrpInf/OrgnlMsgNmId` translated
to the ISO equivalent of the cancelled MT, plus `OrgnlCreDtTm`; 79 ⇒
`CxlRsnInf/Rsn/Cd` when it opens with an ISO reason code (`AGNT`, `AM09`,
`COVR`, `CURR`, `CUST`, `CUTA`, `DUPL`, `FRAD`, `TECH`, `UPAY`), otherwise
`CxlRsnInf/AddtlInf`.

## MT196 → camt.029.001.09

20 → `Assgnmt/Id`; 21 → `RslvdCase/Id`; 76 ⇒ `Sts/Conf`, inferred from the
wording (`CNCL`, `RJCR`, `PDCR`, `ACNR`) and always reported as
`MX.INVESTIGATION_STATUS`. An answer with no recognisable outcome yields `PDCR`
and a warning to review it before sending.
