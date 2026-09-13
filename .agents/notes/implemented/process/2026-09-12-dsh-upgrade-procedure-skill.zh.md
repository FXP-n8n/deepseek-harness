# Agent Note: 升级流程以仓库技能作为唯一归属

Status: implemented

[English](2026-09-12-dsh-upgrade-procedure-skill.md) | 中文

## Problem

仓库中没有任何一处统一说明一次升级会改动什么、又会保留什么，因此操作者只能从启动器的标志、桌面运行时的描述、Session 格式记录和 npm 发布序列中拼凑答案。

这些失效模式是静默的而非响亮的：profile 从不原地升级，dist-tag 未必指向最新的构建，而 Session 数据只向前转换。

## Decision

`.agents/skills/dsh-upgrade` 以一份面向 agent 的指令承担升级流程：确认安装形态、移动运行时、保留产品数据、验证结果。

该技能负责流程与失效模式：四种安装形态及其升级动作，源码检出的“整合—重装—重建—重启”顺序，已发布 CLI 的“安装并确认”步骤，`dsh plugin` 的转发路径，`--from-default-profile` 初始化新 profile 而非升级现有 profile，以及 Session 只向前转换的规则。

对于已有归属方承载的事实，该技能改为链接而不复述：写入器版本与最新已发布格式归 [Session 格式版本与发布状态](../../../../docs/session-format-status.zh.md)，版本如何到达注册表、由哪个 dist-tag 承载归 [npm 发布序列](2026-08-10-npm-release-sequences.zh.md)，桌面运行时及其外部插件安排归[架构](../../../../docs/architecture.zh.md)。

该技能只陈述一次的不变量是产品数据：运行时移动，而 `$DSH_HOME` 保留 profiles、sessions、settings、attachments 与 storages。

## Alternatives considered

**放在 `docs/` 的指南。** 面向人类读者的指南会重复启动器的标志参考和已经拥有这些事实的发布记录。

**扩展某个包的 README。** 没有任何单一包拥有升级：CLI 启动器、profile bundle、桌面运行时和 Session 格式各自拥有一部分，而升级流程横跨全部四者。

**只写一份散文 Agent Note。** Note 记录决策且无法被调用，因此每次升级仍需重新拼凑流程。

**在技能中复述发布序列。** 注册表标签与工作流随发布流程变动，技能内的副本会与其归属方产生偏离。

## Consequences

升级如今从一份指令文件开始，而不是四个归属方，并且这份文件就是该流程的维护点：profile 初始化、启动器标志或 Session 只向前转换规则发生变化时，必须在同一次改动中更新该技能。

该技能刻意不包含发布侧流程——裁剪与发布仍归发布脚本与工作流——并且不陈述启动器未暴露的任何安装命令。
