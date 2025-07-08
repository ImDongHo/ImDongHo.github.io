const $toolButton = document.body.querySelector(':scope > .button-container');
const $main = document.getElementById('main');
const $otherContainer = $main.querySelector(':scope > .layout-content > .body > .other-container');

// 메일, 연락처 버튼 클릭 시 텍스트 복사
const copyText = (item) => {
    const text = item.querySelector(':scope > .tooltip').textContent;
    const textarea = document.createElement('textarea');
    textarea.textContent = text;
    document.body.append(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
    alert('복사되었습니다.');
};

$toolButton.querySelectorAll(':scope > .button').forEach(($item) => {
    $item.addEventListener('click', () => {
        copyText($item);
    });
});


// 스크롤 시 좌측 career, project, education 버튼 색상 변화
window.addEventListener('scroll', (e) => {
    const contentCareer = $otherContainer.querySelector(':scope > .other-content > .career > .titleBox');
    const contentProject = $otherContainer.querySelector(':scope > .other-content > .project > .titleBox');
    const contentEducation = $otherContainer.querySelector(':scope > .other-content > .education > .titleBox');
    const contentCertificate = $otherContainer.querySelector(':scope > .other-content > .certificate > .titleBox');
    const contentExperience = $otherContainer.querySelector(':scope > .other-content > .experience > .titleBox');

    const buttonCareer = $otherContainer.querySelector(':scope > .category > .a.career');
    const buttonProject = $otherContainer.querySelector(':scope > .category > .a.project');
    const buttonEducation = $otherContainer.querySelector(':scope > .category > .a.education');
    const buttonCertificate = $otherContainer.querySelector(':scope > .category > .a.certificate');
    const buttonExperience = $otherContainer.querySelector(':scope > .category > .a.experience');


    if (contentCareer.getBoundingClientRect().y < 800
        && contentProject.getBoundingClientRect().y > 300) {
        buttonCareer.style.color = '#efeff1';
        buttonProject.style.color = '#373737';
        buttonEducation.style.color = '#373737';
        buttonCertificate.style.color = '#373737';
        buttonExperience.style.color = '#373737';
    } else if (contentProject.getBoundingClientRect().y < 300
        && contentEducation.getBoundingClientRect().y > 300) {
        buttonCareer.style.color = '#373737';
        buttonProject.style.color = '#efeff1';
        buttonEducation.style.color = '#373737';
        buttonCertificate.style.color = '#373737';
        buttonExperience.style.color = '#373737';
    } else if (contentEducation.getBoundingClientRect().y < 300
        && contentCertificate.getBoundingClientRect().y > 300) {
        buttonCareer.style.color = '#373737';
        buttonProject.style.color = '#373737';
        buttonEducation.style.color = '#efeff1';
        buttonCertificate.style.color = '#373737';
        buttonExperience.style.color = '#373737';
    } else if (contentCertificate.getBoundingClientRect().y < 300
        && contentExperience.getBoundingClientRect().y > 300) {
        buttonCareer.style.color = '#373737';
        buttonProject.style.color = '#373737';
        buttonEducation.style.color = '#373737';
        buttonCertificate.style.color = '#efeff1';
        buttonExperience.style.color = '#373737';
    } else if (contentExperience.getBoundingClientRect().y < 300) {
        buttonCareer.style.color = '#373737';
        buttonProject.style.color = '#373737';
        buttonEducation.style.color = '#373737';
        buttonCertificate.style.color = '#373737';
        buttonExperience.style.color = '#efeff1';
    } else {
        buttonCareer.style.color = '#373737';
        buttonProject.style.color = '#373737';
        buttonEducation.style.color = '#373737';
        buttonCertificate.style.color = '#373737';
        buttonExperience.style.color = '#373737';
    }
});

// 스크롤 시 내용 표시
/* 요소와 뷰포트의 가시성 교차를 관찰하기 위한 객체 IntersectionObserver 객체화 및 관찰 함수 정의 */
const intersectionObserver = new IntersectionObserver((entries) => {
    /* 모든 관찰 대상(entries)에 대해 */
    entries.forEach((entry) => {
        /* 만약 관찰 대상이 뷰포트의 가시성에 대해 교차중이면(보이고 있으면) */
        if (entry.isIntersecting === true) {
            /* visible 클래스 추가 */
            entry.target.classList.add('visible');
        } else {
            /* 안 보이면 visible 클래스 제거 */
            entry.target.classList.remove('visible');
        }
    });
}, {
    /* 뷰포트에 대한 마진 -n px는 실제 관찰할 뷰포트보다 더 좁은 영역에 대해 관찰을 하겠다는 의미. 더 큰 값이나, 작은 값을 부여하여 차이를 관찰해 볼 것. */
    rootMargin: '-30px 0px -100px 0px'
});
/* 모든 .box를 선택하고 유사배열객체(NodeList)를 실제 배열로 전환하기 위해 Array.from 호출 */
const $boxes = Array.from($otherContainer.querySelectorAll(':scope > .other-content > .box'));
/* 선택한 .box 요소들을 반복하여 교차 관찰 객체에 관찰(observer)함수 호출 */
$boxes.forEach(($box) => intersectionObserver.observe($box));


// experience 내 버튼 클릭 시 experienceDialog 표출
const $experienceDialog = document.getElementById('experienceDialog');

const showExperienceDialog = (item) => {
    $experienceDialog.classList.add('visible');

    $experienceDialog.querySelectorAll(':scope > .content-container > .content').forEach(($item) => {
        if ($item.classList.contains(item.dataset['value'])) {
            $item.classList.add('visible');
        } else {
            $item.classList.remove('visible');
        }
    });
};

const hideExperienceDialog = () => {
    $experienceDialog.classList.remove('visible');

    $experienceDialog.querySelectorAll(':scope > .content-container > .content').forEach(($item) => {
        $item.classList.remove('visible');
    });
};

$otherContainer.querySelectorAll(':scope > .other-content > .box.experience > .experienceBox > .buttonBox').forEach(($item) => {
    $item.addEventListener('click', () => {
        showExperienceDialog($item);
    });
});

$experienceDialog.querySelector(':scope > .content-container > .button.cancel').onclick = () => hideExperienceDialog();
$experienceDialog.addEventListener('mouseup', (mouseupEvent) => {
    if (mouseupEvent.target === mouseupEvent.currentTarget) {
        $experienceDialog.classList.remove('visible');
    }
});

// project 내 버튼 클릭 시 projectDialog 표출
const $projectDialog = document.getElementById('projectDialog');

const showProjectDialog = (item) => {
    $projectDialog.classList.add('visible');

    $projectDialog.querySelectorAll(':scope > .content-container > .content').forEach(($item) => {
        if ($item.classList.contains(item.dataset['value'])) {
            $item.classList.add('visible');
        } else {
            $item.classList.remove('visible');
        }
    });
};

const hideProjectDialog = () => {
    $projectDialog.classList.remove('visible');

    $projectDialog.querySelectorAll(':scope > .content-container > .content').forEach(($item) => {
        $item.classList.remove('visible');
    });
}

$otherContainer.querySelectorAll(':scope > .other-content > .box.project > .projectBox > .buttonBox').forEach(($item) => {
    $item.addEventListener('click', () => {
        showProjectDialog($item);
    });
});


// Dialog 클릭 시 닫기
$projectDialog.querySelector(':scope > .content-container > .button.cancel').onclick = () => hideProjectDialog();
$projectDialog.addEventListener('mouseup', (mouseupEvent) => {
    if (mouseupEvent.target === mouseupEvent.currentTarget) {
        $projectDialog.classList.remove('visible');
    }
});